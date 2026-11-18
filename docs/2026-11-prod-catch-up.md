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
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'cd /root/roitsystems-infra && git log -1 --format="%h %ad" --date=short && git status --short && git stash list && docker ps --format "{{.Names}} {{.Image}} {{.Status}}" | sort && df -h / | tail -1'
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
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'cd /root/roitsystems-infra && find . -name ".env*" ! -name ".env.example" -exec stat -c "%a %U:%G %F %n" {} \; | sort -k4'
```

**Expect:** five `.env` files and five `.env.bak…` entries.
`infrastructure/.env.bak.pre-natsauth-20260915-211550` is listed as a
`symbolic link`.

**Change:**

```sh
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'set -e; cd /root/roitsystems-infra; L=infrastructure/.env.bak.pre-natsauth-20260915-211550; [ -L "$L" ] && rm -- "$L"; install -d -m 700 /root/env-backups/roitsystems-infra; for f in $(find . -name ".env.bak*" -type f); do d=/root/env-backups/roitsystems-infra/$(dirname "$f"); install -d -m 700 "$d"; mv -n -- "$f" "$d/"; done; find . -name ".env" -type f -exec chown root:root {} \; -exec chmod 600 {} \;; chmod -R go-rwx /root/env-backups; find . -name ".env*" ! -name ".env.example" -exec stat -c "%a %U:%G %F %n" {} \;; find /root/env-backups -type f'
```

**Expect:** five `.env` files, each `600 root:root regular file`, no `.env.bak`
left in the checkout, and four files under `/root/env-backups/roitsystems-infra/`.

**Rollback:** move the files back with `mv /root/env-backups/roitsystems-infra/<path> /root/roitsystems-infra/<path>`.
The link is not needed by anything. Root runs every service, so 600 changes
nothing for the containers.

The root `.env` sets some names twice. With duplicates, the last value wins.
Leave the file as it is in this step. De-duplicating it is a separate change
after checking which tool reads it.

## Step 2: back up CouchDB (no restart)

Step 6 recreates CouchDB on its data volume with a new patch version
(3.5.2 → 3.5.3). DEPLOY.md asks for a backup first.

**Check:** free space, which must be more than the size of the volume.

```sh
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'du -sh /var/lib/docker/volumes/infrastructure_couchdb-data/_data; df -h / | tail -1'
```

**Change:**

```sh
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'install -d -m 700 /root/backups && docker run --rm -v infrastructure_couchdb-data:/data:ro -v /root/backups:/b alpine:3.24 tar czf /b/couchdb-data-$(date -u +%Y%m%dT%H%MZ).tgz -C /data . && ls -l /root/backups'
```

**Expect:** a new `couchdb-data-<time>.tgz` of a plausible size.

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
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'cd /root/roitsystems-infra && git status --porcelain --untracked-files=no | wc -l && git fetch -q origin main && git merge-base --is-ancestor HEAD origin/main && echo "fast-forward OK" && git log --oneline HEAD..origin/main | wc -l'
```

**Expect:** `0`, then `fast-forward OK`, then the number of new commits.

**Change:**

```sh
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'cd /root/roitsystems-infra && git merge --ff-only origin/main && git log -1 --format="%h %ad %s" --date=short'
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
logging driver. Use the commands in that section exactly. In summary: install
`infrastructure/journald/30-retention.conf`, restart `systemd-journald`, and
vacuum to 1 GB. The file comes from `main`, so this step follows step 3.

**Check:**

```sh
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'systemd-analyze cat-config systemd/journald.conf | grep -E "^(MaxRetentionSec|SystemMaxUse)="; journalctl --disk-usage'
```

If this already shows `29day` and `1G`, skip the step.

**Rollback:** remove `/etc/systemd/journald.conf.d/30-retention.conf` and restart
`systemd-journald`.

## Step 5: dry run (read-only)

```sh
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'cd /root/roitsystems-infra && ./deploy.sh --dry-run'
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
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'cd /root/roitsystems-infra && ./deploy.sh image-converter'
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'cd /root/roitsystems-infra && ./deploy.sh contact-inbox'
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'cd /root/roitsystems-infra && ./deploy.sh --allow-caddy-restart infrastructure'
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'cd /root/roitsystems-infra/corporate-network/anchor-weather-notifications && docker compose up -d --build && docker ps --filter name=anchor-weather-notifications --format "{{.Names}} {{.Status}}"'
```

**Expect:** after each target, `deploy.sh` reports the anchor-weather container
set unchanged, plus its own health checks. After `infrastructure`, the
in-container config files match the checkout:

```sh
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'cd /root/roitsystems-infra/infrastructure && sha256sum caddy/Caddyfile nats/nats.conf && docker exec infrastructure-caddy-1 sha256sum /etc/caddy/Caddyfile && docker exec infrastructure-nats-1 sha256sum /etc/nats/nats.conf && docker exec infrastructure-caddy-1 caddy version'
```

The two pairs of hashes must match, and Caddy must report `v2.11.9`. Do not
rely on exit codes for this.

**Rollback (per target):** put that target's folder back to the old commit and
recreate it.

```sh
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'cd /root/roitsystems-infra && git checkout 4c08bcb -- <target folder> && cd <target folder> && docker compose up -d --build'
```

For `infrastructure`, the old images (`caddy:2`, `nats:2`, `couchdb:3`) are
still in the local image cache until pruned, so do not prune images until all
four targets are checked. CouchDB can also be restored from the step 2 backup.
Afterwards, `git checkout main -- <target folder>` returns the checkout to
`main`.

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
never reaches a running container; they must be recreated. The images do not
change (`--no-build`).

**Check:**

```sh
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'cd /root/anchor-weather && grep -c "^FRONTEND_URL=" .env && grep "^FRONTEND_URL=" .env && for c in backend worker scheduler; do docker exec anchor-weather-$c printenv FRONTEND_URL; done'
```

**Expect:** `1`, then `FRONTEND_URL=https://anchor-weather.selkietech.ca`, then
the same value from each of the three containers.

**Change:**

```sh
ssh -i ~/.ssh/roitsystems root@"$DROPLET" 'set -e; cd /root/anchor-weather; cp -p .env .env.bak.pre-frontend-url-$(date -u +%Y%m%dT%H%MZ); sed -i "s#^FRONTEND_URL=.*#FRONTEND_URL=https://vectorweather.ca#" .env; docker compose -f docker-compose.prod.yml up -d --no-deps --no-build backend worker scheduler; sleep 20; for c in backend worker scheduler; do docker exec anchor-weather-$c printenv FRONTEND_URL; done; docker ps --filter name=anchor-weather-backend --format "{{.Names}} {{.Status}}"'
```

**Expect:** `https://vectorweather.ca` three times, and the backend `Up` (then
`healthy`). Vector Weather's API pauses for a few seconds while the backend
restarts.

**Rollback:** copy the `.env.bak.pre-frontend-url-<time>` file back over `.env`
and run the same `docker compose … up -d --no-deps --no-build backend worker scheduler`.
Sign-in links sent before the change keep working, because the old host
redirects to `vectorweather.ca` with the path kept.
