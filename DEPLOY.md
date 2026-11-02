# Deployment Guide

## Prerequisites

- Docker and Docker Compose installed on the target machine
- SSH access to the deployment server
- `.env` file with all required secrets configured (see [Configuration](#configuration) below)

## Quick Start

### 1. Configure Environment Variables

Copy the example to `.env` and fill in your values:

```bash
cp .env.example .env
```

`deploy.sh` reads each target's own `.env`: `infrastructure/.env`,
`corporate-network/contact-inbox/.env` and
`corporate-network/image-converter/.env`. They can be copies of, or links to,
the same file.

Edit `.env` and set:
- `API_DOMAIN` — your public domain (e.g., `api.roitsystems.ca`)
- `CADDY_EMAIL` — email for Let's Encrypt certificate renewal
- `COUCHDB_USER` and `COUCHDB_PASSWORD` — strong credentials
- `SESSION_SECRET` — signs admin sessions; at least 32 characters, generate with `openssl rand -hex 32`
- `ADMIN_EMAILS` — comma-separated Google accounts allowed into the admin pages
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` — Google sign-in for the admin pages
- `CLAUDE_API_KEY` — from console.anthropic.com
- `RESEND_API_KEY` — from resend.com
- All other secrets

**⚠️ Security**: Never commit `.env` to version control. It's in `.gitignore`.

### 2. Deploy

```bash
./deploy.sh [--dry-run] [--allow-caddy-restart] [target ...]
```

Targets are `infrastructure`, `contact-inbox`, `image-converter`; no target
deploys all three. The script:

1. Refuses to run under docker-compose v1 (broken on the prod host — its
   recreate path dies with `KeyError: 'ContainerConfig'` and leaves the
   service down), over local edits to tracked files, or alongside another
   running deploy (lock file).
2. Fast-forwards the checkout to `origin/main`.
3. **Converges** each target with `docker compose up -d` — only containers
   whose image or config changed are recreated; nothing is `down`ed, no
   volume is ever removed, and nothing is pruned.
4. Applies Caddyfile changes with a zero-downtime `caddy reload`. It will
   **not** recreate the Caddy container itself unless you pass
   `--allow-caddy-restart`, because Caddy also fronts the anchor-weather
   production domains that share this host (see below).
5. Verifies: the anchor-weather containers are byte-for-byte the same set
   before and after, NATS answers on `127.0.0.1:4222`, and the public
   health endpoint responds.

Use `--dry-run` first to see exactly which containers a deploy would
recreate, without changing anything.

**⚠️ Shared host**: this stack shares the production droplet with
anchor-weather, and `infrastructure/`'s Caddy terminates TLS for
anchor-weather's public domains too. Never deploy with `docker compose
down`, `-v`, or `docker system prune` by hand — `down -v` destroys the
CouchDB/NATS-JetStream/TLS-certificate volumes, and a prune can delete
images from under a concurrently running anchor-weather deploy.

### 3. Verify Deployment

The script verifies automatically (step 5 above). To check by hand:

```bash
# Check all containers are running
docker ps

# Test the health endpoint
curl https://pubapi.roitsystems.ca/health

# Check logs (example)
docker logs infrastructure-caddy-1
docker logs contact-inbox-api
```

### 4. Deploy to Production

On the target machine (e.g., production droplet):

```bash
# SSH into the server. Note: the public hostnames are Cloudflare-proxied
# and do not accept SSH — connect to the droplet's direct IP (kept in the
# private ops notes, not in this public repo).
ssh root@<droplet-ip>

cd /root/roitsystems-infra

# Preview, then deploy one target (the script does its own git pull)
./deploy.sh --dry-run contact-inbox
./deploy.sh contact-inbox
```

Follow the release process below for every production deploy.

## Release Process

Production deploys are manual, by one person, one target at a time.
(`.github/workflows/deploy.yml` has no credentials configured and does not
deploy anything.)

### Before deploying (gates)

Don't start unless all of these hold:

1. **CI is green on the commit you will deploy.** The CI workflow
   (`.github/workflows/ci.yml`) runs on every pull request and every push to
   `main`. For each Node service it installs from the lockfile, builds, runs
   the unit tests where there are any, builds the Docker image, and runs its
   smoke test. Check the run for the `main` commit on GitHub's Actions tab.
2. **Compose files validate.** CI's `compose config` job checks every
   `docker-compose.yml` against `.env.example`: it must parse, and every
   setting it uses must be listed there. On the server, also check each
   target you deploy against its real `.env`, the way `deploy.sh` reads it.
   From the checkout root:

   ```bash
   d=corporate-network/contact-inbox   # or infrastructure, corporate-network/image-converter
   docker compose --project-directory "$d" -f "$d/docker-compose.yml" config --quiet
   ```

   A "variable is not set" warning means that target's `.env` lacks a
   setting. (The "attribute `version` is obsolete" warning is harmless.)
3. **The services start.** CI's smoke tests (`scripts/smoke/run.sh`) start
   each image against throwaway NATS and CouchDB and check it: for
   contact-inbox's API, `/health`, the contact route (invalid and valid
   posts), and admin routes refusing forged or missing sessions. A failed
   smoke test is a hard stop for that service. To rerun one locally:

   ```bash
   docker build -t local/contact-inbox-api corporate-network/contact-inbox/api
   IMAGE=local/contact-inbox-api scripts/smoke/run.sh contact-inbox-api
   ```

   `scripts/smoke/run.sh --list` shows the services that have a smoke test.
4. **Session settings are present.** contact-inbox's API and
   image-converter's API refuse to start unless `SESSION_SECRET` is at least
   32 characters and `ADMIN_EMAILS` names at least one admin. Both services
   must use the same `SESSION_SECRET`. Check each one's `.env`
   (`corporate-network/contact-inbox/.env` and
   `corporate-network/image-converter/.env`, which `deploy.sh` reads) without
   printing the values. Run these in each of the two directories:

   ```bash
   # Quotes and a trailing " # comment" aren't part of the value, as in Compose.
   sed -n 's/^SESSION_SECRET=//p' .env | sed 's/[[:space:]]\{1,\}#.*//' | tr -d "\"'\n" | wc -c   # 32 or more
   sed -n 's/^ADMIN_EMAILS=//p' .env | sed 's/[[:space:]]\{1,\}#.*//' | tr -d "\"'" | tr ',' '\n' | grep -c '[^[:space:]]'  # 1 or more
   ```
5. **Open PRs touching the target** are merged or deliberately left for a
   later deploy.
6. **The server checkout is clean.** `git status` shows no edits to tracked
   files, and `git stash list` shows nothing you need. (`deploy.sh` refuses
   a dirty tree anyway.)

### Deploying

1. Note the commit currently deployed: `git log --oneline -1`.
2. `./deploy.sh --dry-run <target>` and read which containers it would
   recreate. If Caddy is listed, stop and plan a quiet window.
3. `./deploy.sh <target>`. Do one target at a time, in the order
   `infrastructure`, `contact-inbox`, `image-converter`, and only those that
   changed.
4. Run the checks below before moving on to the next target.

### After deploying (checks)

1. `deploy.sh` reports the anchor-weather containers unchanged. Any
   difference means stop and investigate.
2. Every recreated container is up and not restarting (`docker ps`; look for
   a rising restart count). A service that refuses its settings at start-up
   (gate 4) exits and restarts in a loop; its log says which setting.
3. The [health checks](#health-checks) answer, including the public sites
   served through Caddy.
4. A few minutes of `docker logs` for the recreated containers show no new
   errors.

If a check fails, roll back (see [Rollback](#rollback)).

### Planned improvements

- Images tagged by commit, with the last two kept, so a rollback needs no
  rebuild.
- Optionally later, a manually started deploy workflow that requires
  approval and uses a key restricted to `deploy.sh`.

## Log retention (30 days)

Every container logs to the host's journal (the `journald` logging driver, set in
each `docker-compose.yml` and tagged with the container's name). The journal
keeps nothing older than 30 days, so request logs and the visitor addresses in
them are kept 30 days at most. This applies to the host's own logs (sshd,
fail2ban and the rest) too.

Size-based Docker log options (`max-size`, `max-file`) can't promise that: a
quiet service would keep the same few megabytes for months.

**Setting it up (once, before deploying the compose change):**

```bash
install -D -m 0644 infrastructure/journald/30-retention.conf /etc/systemd/journald.conf.d/30-retention.conf
systemctl restart systemd-journald
systemd-analyze cat-config systemd/journald.conf | grep -E '^(Storage|MaxRetentionSec|MaxFileSec|SystemMaxUse|RateLimit[A-Za-z]+)='
ls -d /var/log/journal && journalctl --disk-usage
getent group adm systemd-journal   # who can read the journal: should list no one but root
```

`infrastructure/journald/30-retention.conf` sets:
- `Storage=persistent`, so logs survive a reboot;
- `MaxRetentionSec=30day`, with `MaxFileSec=1day`: journald deletes whole files,
  so it starts one a day;
- `SystemMaxUse=2G`;
- a higher rate limit (`RateLimitBurst=50000` per 30 s), because all containers
  share `docker.service`'s.

The journal is readable by root and by members of the `adm` and
`systemd-journal` groups, so the last command checks that those groups have no
other members.

**Rolling out the compose change:** a new logging driver recreates every
container of a target on its next deploy, and the old Docker log files go with
the old containers.
1. Deploy `image-converter` first. Then check that
   `docker logs --tail 5 image-converter-api` and
   `journalctl CONTAINER_NAME=image-converter-api -n 5` both show its lines.
2. Then `contact-inbox`.
3. Then `infrastructure`. This recreates Caddy, NATS and CouchDB. It needs
   `--allow-caddy-restart` and a quiet moment, since Caddy and NATS serve
   anchor-weather too. Back up CouchDB first. If the image pins (#120, #121)
   are merged by then, deploy them in the same step, so there's one restart,
   not two.
4. anchor-weather-notifications isn't a `deploy.sh` target. Its compose file is
   updated too, and takes effect wherever it's deployed.

To read a container's logs: `docker logs <container>`, or
`journalctl CONTAINER_NAME=<container>` (add `--since "2 days ago"` and so on).

## Configuration Details

### Required Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `API_DOMAIN` | Public hostname | `api.roitsystems.ca` |
| `CADDY_EMAIL` | TLS certificate email | `admin@example.com` |
| `COUCHDB_USER` | Database admin | `admin` |
| `COUCHDB_PASSWORD` | Database password | `[strong password]` |
| `SESSION_SECRET` | Signs admin sessions (contact-inbox and image-converter APIs; at least 32 characters, or they won't start) | `[openssl rand -hex 32]` |
| `ADMIN_EMAILS` | Google accounts allowed into the admin pages (at least one, or the APIs won't start) | `admin@example.com` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in for the admin pages | From Google Cloud Console |
| `CLAUDE_API_KEY` | Claude API access | From console.anthropic.com |
| `RESEND_API_KEY` | Email service | From resend.com |
| `NOTIFICATION_EMAIL` | Recipient email | `admin@example.com` |
| `NOTIFICATION_FROM_EMAIL` | Sender email | `notifications@roitsystems.ca` |

### Optional Variables

- `CORS_ORIGINS` — comma-separated list of allowed origins (default: `https://roitsystems.ca`)
- `NODE_ENV` — `production` or `development` (default: `production`)
- `LOG_LEVEL` — `debug`, `info`, `warn`, `error` (default: `info`)
- `RATE_LIMIT_MAX` — max requests per window (default: `10`)
- `RATE_LIMIT_WINDOW_MS` — rate limit window in ms (default: `900000` = 15 min)
- `NOTIFICATION_WEBHOOK_URL` — webhook for notifications (optional, leave empty to disable)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Caddy (TLS termination, reverse proxy)                       │
│ Port: 80, 443                                               │
└─────────────┬───────────────────────────────────────────────┘
              │
    ┌─────────┴──────────┬────────────────┐
    │                    │                │
┌───▼──────────┐    ┌────▼─────────┐    │
│ Contact      │    │ Image        │    │
│ Inbox API    │    │ Converter    │    │
│ :3000        │    │ API :3000    │    │
└───┬──────────┘    └────┬─────────┘    │
    │                    │                │
┌───▼──────────┐    ┌────▼─────────┐    │
│ Contact      │    │ ImageMagick  │    │
│ Inbox Worker │    │ Service      │    │
│              │    │              │    │
└──────────────┘    └──────────────┘    │
                                         │
┌────────────────────────────────────────▼──┐
│ Shared Infrastructure (corporate-backend) │
├─────────────────────────────────────────────┤
│ • NATS (event streaming) :4222            │
│ • CouchDB (document store) :5984          │
│ • Redis (optional caching)                │
└───────────────────────────────────────────────┘
```

All services communicate over the `corporate-backend` Docker network.

## Troubleshooting

### CouchDB won't start ("Admin Party" error)

**Cause**: `COUCHDB_USER` and `COUCHDB_PASSWORD` not being passed to container.

**Fix**: Ensure `.env` exists and contains these variables. The deploy script automatically passes `--env-file .env` to docker-compose.

```bash
grep COUCHDB .env
docker compose logs infrastructure_couchdb_1 | tail -20
```

### Containers can't reach infrastructure services

**Cause**: Docker network issues or DNS resolution failures.

**Fix**: Verify all containers are on the `corporate-backend` network:

```bash
docker network inspect corporate-backend
```

All `image-converter-*`, `contact-inbox-*`, and `infrastructure_*` containers should be listed.

### API keys not available in containers

**Cause**: Environment variables not exported to running containers.

**Fix**: The deploy script exports all `.env` variables before running docker-compose. Verify:

```bash
docker inspect contact-inbox-notification | grep -A 20 '"Env"'
```

Should contain `CLAUDE_API_KEY`, `RESEND_API_KEY`, etc.

### Email notifications not sending

**Cause**: Invalid `RESEND_API_KEY` or incorrect sender email.

**Fix**:
1. Verify key at https://resend.com/api-keys
2. Verify sender email is authorized at https://resend.com/emails
3. Check logs: `docker logs contact-inbox-notification`

## Manual Commands

If you need to run commands manually (not using `deploy.sh`):

```bash
# Start infrastructure only
cd infrastructure
docker-compose --env-file ../.env up -d --build
cd ..

# Start contact-inbox
cd corporate-network/contact-inbox
docker-compose --env-file ../../.env up -d --build
cd ../..

# Start image-converter
cd corporate-network/image-converter
docker-compose --env-file ../../.env up -d --build
cd ../..

# View logs
docker-compose logs -f [service-name]

# Stop all services
docker-compose down
```

## Health Checks

Once deployed, test these endpoints. None of them stores anything or sends
email.

```bash
# Health checks (should return 200): contact-inbox's API, then image-converter's
curl https://pubapi.roitsystems.ca/health
curl https://pubapi.roitsystems.ca/corporate-network/image-converter/health

# Contact route is up: an invalid submission is refused (should return 400).
# A valid one would store a real message and send a notification email.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://pubapi.roitsystems.ca/api/contact \
  -H "Content-Type: application/json" -d '{}'

# Admin API without a session redirects to Google sign-in (should return 302)
curl -s -o /dev/null -w '%{http_code}\n' https://pubapi.roitsystems.ca/api/admin/messages
```

The admin pages need a Google sign-in with an `ADMIN_EMAILS` account; open
them in a browser:

- https://pubapi.roitsystems.ca/corporate-network/contact/admin
- https://pubapi.roitsystems.ca/corporate-network/image-converter/convert

## Rollback

`deploy.sh` always fast-forwards to `origin/main` before deploying, so
checking out an older commit on the server and running it just deploys
`main` again. Roll back through `main` instead:

1. Revert the bad change on `main` (`git revert <commit>` in a PR, then
   merge).
2. On the server: `./deploy.sh --dry-run <target>`, then
   `./deploy.sh <target>`.
3. Run the [checks](#after-deploying-checks) again.

This rebuilds the images, so it takes a few minutes. Once images are tagged
by commit (see [Planned improvements](#planned-improvements)), a rollback
will switch the service back to the previous tag without a rebuild.
`deploy.sh` never prunes images, so kept tags stay available. Either way,
go through `deploy.sh`, not ad-hoc `docker` commands.

## Next Steps

1. ✅ Run `./deploy.sh` locally to validate configuration
2. ✅ Test all endpoints from "Health Checks" above
3. ✅ Push `.env` securely to production machine (outside of git)
4. ✅ Run `./deploy.sh` on production
5. ⬜ Implement Google Workspace OAuth (deferred)
6. ⬜ Set up monitoring and alerting
