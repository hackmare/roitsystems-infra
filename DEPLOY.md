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

Production deploys are manual, by one person, one target at a time: from a
shell on the server, or, once it's set up, from the
[push-button workflow](#push-button-deploy-not-set-up-yet). Either way, the gates
and checks below apply.

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

### Push-button deploy (not set up yet)

`.github/workflows/deploy-manual.yml` deploys one target from GitHub's Actions
tab. **It does nothing until the steps below are done**: without the Environment's
secrets, every run stops at its first step.

**How a run works**
1. In Actions → *Deploy (manual)* → *Run workflow*, pick the target, and *dry-run*
   or *deploy*. Runs start only from `main`, and only one at a time.
2. The **dry-run job** waits for approval in the `production-deploy` Environment,
   then runs `./deploy.sh --dry-run <target>` on the server. Read its output.
3. If you chose *deploy*, the **deploy job** waits for a second approval, then runs
   `./deploy.sh <target>`. Then do the [checks](#after-deploying-checks).

The workflow's key can only run the deploy gate, a copy of
`scripts/deploy-gate.sh` installed outside the checkout, so a change merged to
`main` can't change what the key may do.
- **What it accepts:** exactly `dry-run <target>` or `deploy <target>`, for the
  three targets, and nothing else: no shell, no other arguments, never
  `--allow-caddy-restart`.
- **When it deploys:** only after a dry run of that target in the last 30
  minutes, with `main` unmoved since. It then deploys exactly the commit the dry
  run showed (`DEPLOY_COMMIT`), even if someone pushes in between. One dry run
  allows one deploy.
- **What it shows:** **the Actions log is public**, like the repository. So the
  gate keeps `deploy.sh`'s full output in a root-only file under
  `/var/log/roitsystems-deploy/` and returns one line: the result, the short
  commit, the containers recreated (or that would be), and the number of
  warnings. Read the file on the server for the details.

`scripts/test-deploy-gate.sh` tests all of this, and CI runs it.

**Setting it up (once)**
1. **Make a key just for this**, on your own machine:
   `ssh-keygen -t ed25519 -N '' -C github-actions-deploy -f deploy_key`.
2. **On the server, install the gate** from a checkout of `main` you've read:
   ```bash
   install -o root -g root -m 0755 /root/roitsystems-infra/scripts/deploy-gate.sh /usr/local/sbin/roitsystems-deploy-gate
   install -d -m 700 /var/lib/roitsystems-deploy-gate /var/log/roitsystems-deploy
   ```
   Then allow the key to run it and nothing else. Add one line to the deploy
   user's `~/.ssh/authorized_keys` (`restrict` turns off shells, port
   forwarding and the rest):
   ```
   restrict,command="/usr/local/sbin/roitsystems-deploy-gate" ssh-ed25519 AAAA... github-actions-deploy
   ```
   When a later PR changes `scripts/deploy-gate.sh`, nothing happens on the
   server until you read it and run the first `install` command again. The
   gate also refuses to run from inside the checkout.
3. **On GitHub, create the Environment first**: Settings → Environments → *New
   environment* `production-deploy`.
   - *Required reviewers*: yourself.
   - *Deployment branches*: `main` only.

   Only then add the four **Environment** secrets (never repository secrets,
   which any workflow could read):
   - `DEPLOY_SSH_KEY`: the private key from step 1;
   - `DEPLOY_SSH_HOST` and `DEPLOY_SSH_USER`;
   - `DEPLOY_KNOWN_HOSTS`: the server's host key line, from
     `ssh-keyscan -t ed25519 <host>`, checked against
     `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server.
4. Delete `deploy_key` from your machine once it's stored.

If the workflow is run before step 3, GitHub creates an empty
`production-deploy` Environment with no rules. With no secrets the run still
stops at its first step, but add the reviewer rule before any secret.

**To switch it off:** remove the `authorized_keys` line on the server. Deleting
the Environment's secrets also stops it.

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
