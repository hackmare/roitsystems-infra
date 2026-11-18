# Production catch-up to `main` (November 2026)

The production checkout of this repository has not been deployed since
2026-10-06 (commit `4c08bcb`). Since then about 80 pull requests have merged
to `main`. They include exact image pins for Caddy, NATS and CouchDB, journald
log retention, least-privilege settings for the Node services, Caddy's
Cloudflare client-address handling, and the redirect of
`weather-vector.selkietech.ca` to `vectorweather.ca` (#129). None of them run in
production yet.

This plan brings production up to `main` in small steps, each with a check and a
rollback. The last section is a separate, unrelated change to Vector Weather's
`FRONTEND_URL`.

## How to use this plan

- **Morgane runs every production command**, reads included, as one `ssh` line
  from her Mac. No agent session connects to production.
- Before the first line, set the server address once in the terminal. It is
  kept in the private ops notes, not in this public repository:

  ```sh
  DROPLET=<droplet address from the private ops notes>
  ```

- Each step lists **check** (read-only), **change**, **expect**, and
  **rollback**. Run the check first. If the output differs from **expect**,
  stop and send it to the lead before going on.
- Steps are in order. Steps 1 to 5 restart no service (step 4 restarts only the host's `systemd-journald`). Step 6 restarts services,
  and the `infrastructure` part needs a quiet moment because Caddy and NATS also
  serve Vector Weather.
- Public checks (the `curl` lines in step 7) can be run by anyone, from
  anywhere.

## Step 0: snapshot (read-only)

Records the starting point, so every later step can be compared with it.

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'cd /root/roitsystems-infra && git log -1 --format="%h %ad" --date=short && git status --short && git stash list && docker ps --format "{{.Names}} {{.Image}} {{.Status}}" | sort && df -h / | tail -1'
```

**Expect:** `4c08bcb 2026-10-06`. No tracked files modified (every
`git status` line starts with `??`). Two stashes. Every container `Up`. At least
5 GB free on `/`.

## Step 1: tidy the environment files (no restart)

Local backup copies of environment files sit inside the checkout. Move them to
a root-only folder outside it, and make every environment file in the checkout
root-only. One of the backups (`infrastructure/.env.bak.pre-natsauth-…`) is a
**symbolic link to the live root `.env`**, not a copy. Remove only the link,
guarded so that nothing happens if it is not a link. The live file stays.

**Check:**

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'cd /root/roitsystems-infra && find . -name ".env*" ! -name ".env.example" -exec stat -c "%a %U:%G %F %N" {} \; | sort -k4'
```

**Expect:** five `.env` files and five `.env.bak…` entries.
`infrastructure/.env.bak.pre-natsauth-20260915-211550` is listed as a
`symbolic link` pointing to the root `.env`. **Keep this output**: it is the
record the rollback restores (modes, owners, the link's target).

**Change:**

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'set -e; cd /root/roitsystems-infra; L=infrastructure/.env.bak.pre-natsauth-20260915-211550; [ -L "$L" ] && rm -- "$L"; install -d -m 700 /root/env-backups/roitsystems-infra; for f in $(find . -name ".env.bak*" -type f); do d=/root/env-backups/roitsystems-infra/$(dirname "$f"); install -d -m 700 "$d"; mv -n -- "$f" "$d/"; done; find . -name ".env" -type f -exec chown root:root {} \; -exec chmod 600 {} \;; chmod -R go-rwx /root/env-backups; find . -name ".env*" ! -name ".env.example" -exec stat -c "%a %U:%G %F %n" {} \;; find /root/env-backups -type f'
```

**Expect:** five `.env` files, each `600 root:root regular file`, no `.env.bak`
left in the checkout, and four files under `/root/env-backups/roitsystems-infra/`.

**Rollback:** move the backups back, recreate the link, then set each file
back to the mode and owner the check printed (for example `chmod 644 <file>`).

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'cd /root/env-backups/roitsystems-infra && find . -type f | while read -r f; do mv -n -- "$f" "/root/roitsystems-infra/$f"; done; cd /root/roitsystems-infra && ln -s /root/roitsystems-infra/.env infrastructure/.env.bak.pre-natsauth-20260915-211550; find . -name ".env*" ! -name ".env.example" -exec stat -c "%a %U:%G %F %N" {} \;'
```

The line recreates the link with an absolute target. If the recorded `%N`
output shows a different (for example relative) target, use that one instead.
Nothing uses the link. Root runs every service, so 600 changes nothing for the
containers.

The root `.env` sets some names twice. With duplicates, the last value wins.
Leave the file as it is in this step. De-duplicating it is a separate change
after checking which tool reads it.

## Step 2: back up CouchDB (no restart)

Step 6 recreates CouchDB on its data volume with a new patch version
(3.5.2 → 3.5.3). DEPLOY.md asks for a backup first.

**Check:** free space, which must be more than the size of the volume.

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'du -sh /var/lib/docker/volumes/infrastructure_couchdb-data/_data; df -h / | tail -1'
```

**Change:**

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'install -d -m 700 /root/backups && docker run --rm -v infrastructure_couchdb-data:/data:ro -v /root/backups:/b alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf tar czf /b/couchdb-data-$(date -u +%Y%m%dT%H%MZ).tgz -C /data . && ls -l /root/backups'
```

**Expect:** a new `couchdb-data-<time>.tgz` of a plausible size.

This copies the volume while CouchDB is running. CouchDB writes its files
append-only, so a live copy is normally usable, but it is not a guaranteed
point-in-time snapshot. For a strict copy, stop CouchDB around the `tar`
(the contact forms pause while it is stopped).

**Rollback:** none needed. This only writes a backup.

## Step 3: move the checkout to `main` (no restart)

**Do this as its own step, before running any `deploy.sh`.** The `deploy.sh`
currently on the server is the 2026-10-06 version. Its `--dry-run` fetches
`main` but compares against the old compose files, so its output says nothing
about `main`. Its real run would `git pull`, which rewrites `deploy.sh` while
bash is still reading it. With the checkout on `main` first, `deploy.sh`
becomes `main`'s script, and its dry run shows the real plan.

No tracked file is modified on the server. The untracked files left after step 1
(`.deploy-test.sh`, `FETCH_HEAD`, `package-lock.json`) do not exist on `main`, so
they do not block a fast-forward and are left alone. The two old stashes are
kept.

**Check:**

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'cd /root/roitsystems-infra && git status --porcelain --untracked-files=no | wc -l && git fetch -q origin main && git merge-base --is-ancestor HEAD origin/main && echo "fast-forward OK" && git log --oneline HEAD..origin/main | wc -l'
```

**Expect:** `0`, then `fast-forward OK`, then the number of new commits.

**Change:**

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'cd /root/roitsystems-infra && git merge --ff-only origin/main && git log -1 --format="%h %ad %s" --date=short'
```

**Expect:** the current `main` commit.

**Rollback:** `git -C /root/roitsystems-infra reset --keep 4c08bcb`. This
restores the tracked files only. The ignored `.env` files are not touched.

Moving the checkout changes nothing that is running. Caddy and NATS each
bind-mount a **single file** (`infrastructure/caddy/Caddyfile`,
`infrastructure/nats/nats.conf`). Git replaces those files rather than
rewriting them in place, so the running containers keep seeing the old files
until they are recreated in step 6. A `caddy reload` would reload the **old**
Caddyfile and still report success.

## Step 4: journald retention (one-off, before the compose change)

Every service on `main` logs to the host journal. DEPLOY.md, "Log retention",
installs the retention settings once, before the first deploy that switches the
logging driver. DEPLOY.md records this as done once on 2026-11-12, so the check
will probably show it is already in place. The file comes from `main`, so this
step follows step 3.

**Check:**

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'systemd-analyze cat-config systemd/journald.conf | grep -E "^(MaxRetentionSec|SystemMaxUse)="; journalctl --disk-usage'
```

If this shows `MaxRetentionSec=29day` and `SystemMaxUse=1G`, **skip the
change**.

**Change** (the commands from DEPLOY.md as one line, under both deploy locks so
it cannot run during a deploy; `flock -n` stops at once if one is running):

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'cd /root/roitsystems-infra && flock -n /var/lock/anchor-weather-deploy.lock flock -n /var/lock/roitsystems-infra-deploy.lock sh -c "install -D -m 0644 infrastructure/journald/30-retention.conf /etc/systemd/journald.conf.d/30-retention.conf && systemctl restart systemd-journald && journalctl --vacuum-size=1G" && systemd-analyze cat-config systemd/journald.conf | grep -E "^(MaxRetentionSec|SystemMaxUse)=" && journalctl --disk-usage && journalctl -n 3 --no-pager'
```

**Expect:** `MaxRetentionSec=29day`, `SystemMaxUse=1G`, disk usage 1 GB or
less, and three recent journal lines.

**Rollback:** remove `/etc/systemd/journald.conf.d/30-retention.conf` and
restart `systemd-journald`. **The vacuum cannot be undone**: journal files it
deletes are gone. Export any logs needed for an open incident first.

## Step 5: dry run (read-only)

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'cd /root/roitsystems-infra && ./deploy.sh --dry-run'
```

**Expect:** for each target (`infrastructure`, `contact-inbox`,
`image-converter`), the containers that would be recreated. Every service is
expected to be recreated, because the logging driver changes for all of them.
Caddy is reported as needing `--allow-caddy-restart`. Nothing is changed.

Send the full output to the lead before step 6.

## Step 6: deploy, one target at a time

The order and checks follow DEPLOY.md, "Rolling out the compose change".

| Order | Target | Recreates | Notes |
|---|---|---|---|
| 1 | `image-converter` | `image-converter-api`, `imagemagick-service` | Rebuilt images, run as `node`, read-only file system |
| 2 | `contact-inbox` | api, worker, notification | Same hardening |
| 3 | `infrastructure` | **Caddy, NATS, CouchDB** | Needs `--allow-caddy-restart`. A short outage for every site Caddy fronts, including Vector Weather. Quiet moment only. |
| 4 | `anchor-weather-notifications` | `anchor-weather-notifications` | Not a `deploy.sh` target. Recreate from its own folder |

**Lines** (one target at a time; check after each):

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'cd /root/roitsystems-infra && ./deploy.sh image-converter'
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'cd /root/roitsystems-infra && ./deploy.sh contact-inbox'
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'cd /root/roitsystems-infra && ./deploy.sh --allow-caddy-restart infrastructure'
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'cd /root/roitsystems-infra/corporate-network/anchor-weather-notifications && docker compose up -d --build && docker ps --filter name=anchor-weather-notifications --format "{{.Names}} {{.Status}}"'
```

**Expect:** after each target, `deploy.sh` reports the anchor-weather container
set unchanged, plus its own health checks. After `infrastructure`, the
in-container config files match the checkout:

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'cd /root/roitsystems-infra/infrastructure; sha256sum caddy/Caddyfile nats/nats.conf; docker exec infrastructure-caddy-1 sha256sum /etc/caddy/Caddyfile; docker cp infrastructure-nats-1:/etc/nats/nats.conf - | tar -xOf - | sha256sum; docker exec infrastructure-caddy-1 caddy version'
```

The Caddyfile hashes must match each other, and so must the two `nats.conf`
hashes. Caddy must report `v2.11.9`. The NATS image on `main` has no shell
tools, so its file is read with `docker cp` rather than `docker exec`. The
commands are joined with `;`, not `&&`, so one failure still prints the rest.
Read the hashes; do not rely on exit codes.

**Rollback (per target):** return the whole checkout to the old commit
(as in step 3), then recreate **only** the target that failed, from its folder.
Use `reset --keep`, not `git checkout <commit> -- <folder>`: the latter leaves
the files `main` added, so a rebuild would mix old and new code.

| Target | Folder |
|---|---|
| `image-converter` | `corporate-network/image-converter` |
| `contact-inbox` | `corporate-network/contact-inbox` |
| `infrastructure` | `infrastructure` |
| `anchor-weather-notifications` | `corporate-network/anchor-weather-notifications` |

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'cd /root/roitsystems-infra && git reset --keep 4c08bcb && cd <folder from the table> && docker compose up -d --build && docker compose ps'
```

Targets already deployed and checked keep running: resetting the checkout does
not touch running containers. For `infrastructure`, the old images (`caddy:2`,
`nats:2`, `couchdb:3`) are still in the local image cache until pruned, so do
not prune images until all four targets are checked. CouchDB can also be
restored from the step 2 backup. To go forward again, repeat step 3
(`git merge --ff-only origin/main`).

## Step 7: public checks (anyone can run these)

```sh
for h in vectorweather.ca www.vectorweather.ca anchor-weather.selkietech.ca vector-weather.selkietech.ca weather-vector.selkietech.ca; do printf "%-30s / %s   /api %s\n" "$h" "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' https://$h/)" "$(curl -s -o /dev/null -w '%{http_code}' https://$h/api/health)"; done
```

**Expect:**

| Host | `/` | `/api/health` |
|---|---|---|
| vectorweather.ca | 200 | 200 |
| www.vectorweather.ca | 302 to vectorweather.ca | 302 |
| anchor-weather.selkietech.ca | 302 to vectorweather.ca | 200 |
| vector-weather.selkietech.ca | 302 to vectorweather.ca | 200 |
| weather-vector.selkietech.ca | **302 to vectorweather.ca** (#129) | 200 |

`/api/*` keeps answering on the old hosts on purpose. API clients, including
the Signal K plugin, call them directly and would lose their `Authorization`
header on a cross-host redirect.

## Separate change: Vector Weather `FRONTEND_URL`

This is unrelated to the steps above and can be done before or after them. The
Vector Weather backend builds sign-in links, payment return pages, share links
and alert links from `FRONTEND_URL`. It still points at the old host, so those
links take one redirect hop. The anchor-weather DEPLOY.md already documents
`FRONTEND_URL=https://vectorweather.ca`.

Three services read it: `backend`, `worker` and `scheduler`. An `.env` change
never reaches a running container, so they must be recreated.

**Do not use a plain `docker compose up` from the checkout.** Vector Weather
releases are image-only. The release tooling imports images by id and recreates
services from the compose files named in the running containers' labels, which
may not match the checkout's `docker-compose.prod.yml`. The procedure below,
from the Vector Weather owner, keeps the **running image ids and compose files**
and changes only the environment.

**Before you start:** check in GitHub Actions that no `vw-release` run is
between *prepare* and *activate*. Activation refuses if `.env` changed since
prepare.

**Check** (read-only):

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'for s in backend worker scheduler; do c=$(docker ps --filter label=com.docker.compose.service=$s --filter label=com.docker.compose.project=anchor-weather -q); docker inspect -f "{{.Name}} {{.Image}} {{index .Config.Labels \"com.docker.compose.project.config_files\"}} {{index .Config.Labels \"com.docker.compose.project.working_dir\"}}" $c; done; grep -c "^FRONTEND_URL=" /root/anchor-weather/.env; grep "^FRONTEND_URL=" /root/anchor-weather/.env'
```

**Expect:** exactly one container per service; all three list the same
`config_files`, which exist on disk; `working_dir` is `/root/anchor-weather`;
then `1` and `FRONTEND_URL=https://anchor-weather.selkietech.ca`. **Keep the
three image ids.** If a config file is missing or a service has more than one
container, stop and send the output to the Vector Weather owner.

**Change:** back up `.env` outside the checkout, change the one line, then
recreate the three services on the **same image ids** and the **same compose
files**:

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'set -e; cd /root/anchor-weather; install -d -m 700 /root/env-backups/anchor-weather; cp -p .env /root/env-backups/anchor-weather/.env.pre-frontend-url-$(date -u +%Y%m%dT%H%M%SZ); sed -i "s#^FRONTEND_URL=.*#FRONTEND_URL=https://vectorweather.ca#" .env; O=$(mktemp /tmp/vw-pin-XXXXXX.yml); trap "rm -f $O" EXIT; echo "services:" > $O; F=""; for s in backend worker scheduler; do c=$(docker ps --filter label=com.docker.compose.service=$s --filter label=com.docker.compose.project=anchor-weather -q); printf "  %s:\n    image: %s\n" $s $(docker inspect -f "{{.Image}}" $c) >> $O; F=$(docker inspect -f "{{index .Config.Labels \"com.docker.compose.project.config_files\"}}" $c); done; docker compose -p anchor-weather --project-directory /root/anchor-weather --env-file /root/anchor-weather/.env $(echo "$F" | sed "s/^/-f /; s/,/ -f /g") -f $O up -d --no-deps --no-build backend worker scheduler; docker compose -p anchor-weather ps backend worker scheduler; for c in backend worker scheduler; do docker exec anchor-weather-$c printenv FRONTEND_URL; done; docker inspect -f "{{.Name}} {{.Image}}" anchor-weather-backend anchor-weather-worker anchor-weather-scheduler'
```

**Expect:** the three services `Up` (the backend then `healthy`),
`https://vectorweather.ca` three times, and the **same three image ids as the
check**. Vector Weather's API pauses for a few seconds while the backend
restarts. Then request a sign-in email and confirm its link starts with
`https://vectorweather.ca`. The next release carries the new value on its own.

**Rollback:** put the backup back (the newest one, unless told otherwise) and
recreate the three services on the same image ids and compose files:

```sh
ssh -i ~/.ssh/roitsystems -o IdentitiesOnly=yes root@"$DROPLET" 'set -e; cd /root/anchor-weather; B=$(ls -1t /root/env-backups/anchor-weather/.env.pre-frontend-url-* | head -1); echo "restoring $B"; cp -p "$B" .env; O=$(mktemp /tmp/vw-pin-XXXXXX.yml); trap "rm -f $O" EXIT; echo "services:" > $O; F=""; for s in backend worker scheduler; do c=$(docker ps --filter label=com.docker.compose.service=$s --filter label=com.docker.compose.project=anchor-weather -q); printf "  %s:\n    image: %s\n" $s $(docker inspect -f "{{.Image}}" $c) >> $O; F=$(docker inspect -f "{{index .Config.Labels \"com.docker.compose.project.config_files\"}}" $c); done; docker compose -p anchor-weather --project-directory /root/anchor-weather --env-file /root/anchor-weather/.env $(echo "$F" | sed "s/^/-f /; s/,/ -f /g") -f $O up -d --no-deps --no-build backend worker scheduler; docker compose -p anchor-weather ps backend worker scheduler; for c in backend worker scheduler; do docker exec anchor-weather-$c printenv FRONTEND_URL; done'
```

**Expect:** `restoring …`, the three services `Up`, and
`https://anchor-weather.selkietech.ca` three times. Sign-in links sent before the change keep working,
because the old host redirects to `vectorweather.ca` with the path kept.
