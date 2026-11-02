# Installation & Deployment

The stack is three Docker Compose projects, each in its own folder, each with
its own `.env`:

| Folder | What runs there |
|---|---|
| `infrastructure/` | Caddy (the TLS edge), NATS and CouchDB; it also creates the shared `corporate-backend` network |
| `corporate-network/contact-inbox/` | the contact API, its worker and its notification service |
| `corporate-network/image-converter/` | the image-converter API and the ImageMagick service |

Start them in that order: the other two join the network `infrastructure/`
creates. On the server, `./deploy.sh` does all of this; see
[DEPLOY.md](DEPLOY.md).

> **Never run `docker compose down -v` or `docker system prune --volumes`.**
> Both delete the CouchDB and NATS data volumes, and with them every stored
> message and queued job.

## Prerequisites

- **Docker Engine** with the **Compose v2 plugin** (the `docker compose`
  command). Don't use the old `docker-compose` v1; `deploy.sh` refuses it.
  - Mac or Windows: [Docker Desktop](https://www.docker.com/products/docker-desktop) includes both.
  - Linux: [Docker's official packages](https://docs.docker.com/engine/install/ubuntu/), including `docker-compose-plugin`.
- **A public domain** with DNS control, for production.
- **A server** with 2 GB+ RAM running a current Ubuntu LTS (24.04).
- **Git** and **OpenSSL**.

## Local Development Setup

### 1. Clone the repository

```bash
git clone https://github.com/morgane-oger/roitsystems-infra.git
cd roitsystems-infra
```

### 2. Create each folder's `.env`

Fill in one file from the template, then copy it (or link it) into each
folder:

```bash
cp .env.example .env
# edit .env (below), then:
for d in infrastructure corporate-network/contact-inbox corporate-network/image-converter; do
  cp .env "$d/.env"
done
```

Local values:

```bash
API_DOMAIN=localhost
CADDY_EMAIL=dev@example.com
COUCHDB_USER=admin
COUCHDB_PASSWORD=devpassword
CORS_ORIGINS=https://localhost
NODE_ENV=development   # sign-in cookies work over plain http only outside production
GOOGLE_CLIENT_ID=<from Google Cloud Console>
GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
ADMIN_EMAILS=you@example.com
SESSION_SECRET=<paste the output of: openssl rand -hex 32>
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=900000
LOG_LEVEL=debug
```

### 3. Start the three projects

```bash
for d in infrastructure corporate-network/contact-inbox corporate-network/image-converter; do
  (cd "$d" && docker compose up -d --build)
done
```

`./deploy.sh` isn't for a laptop: it fast-forwards the checkout to
`origin/main` and refuses to run over local edits.

Watch a service start:

```bash
(cd corporate-network/contact-inbox && docker compose logs -f contact-inbox-api)
```

### 4. Verify health

Caddy serves `localhost` with its own local certificate, so `curl` needs `-k`.
The Caddyfile also lists the production domains; on a laptop their
certificates can't be issued, so ignore those errors in Caddy's log.

```bash
curl -k https://localhost/health
# Expected: {"status":"ok","ts":"..."}
```

### 5. Test the contact API

```bash
curl -k -X POST https://localhost/api/contact \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "message": "Hello world"
  }'
```

### 6. Open the admin pages

- Open **https://localhost/corporate-network/contact/admin**.
- Sign in with Google, using an account listed in `ADMIN_EMAILS`. The Google
  client needs `http://localhost/auth/callback` as a redirect URI (see
  [GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md)).
- The message list is empty on a first run.

### Stopping

```bash
(cd corporate-network/image-converter && docker compose stop)
(cd corporate-network/contact-inbox && docker compose stop)
(cd infrastructure && docker compose stop)
```

`stop` keeps the containers and their data. Start them again with step 3.

---

## Production Deployment

### 1. Create a server

- **Image**: Ubuntu 24.04 LTS
- **Size**: 2 GB RAM minimum
- **Region**: closest to your users

### 2. SSH in

```bash
ssh root@<droplet-ip>
```

### 3. Install Docker Engine and the Compose plugin

Follow [Docker's instructions for Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
(add Docker's apt repository, then install `docker-ce`, `docker-ce-cli`,
`containerd.io` and `docker-compose-plugin`). Check:

```bash
docker compose version   # must print v2 or later
```

Don't install Ubuntu's `docker-compose` package: it's v1.

### 4. Clone

```bash
cd /root
git clone https://github.com/morgane-oger/roitsystems-infra.git
cd roitsystems-infra
```

### 5. Create the production `.env` files

Fill in `.env` from `.env.example`, then copy or link it into the three
folders, as in local step 2. Generate each secret with `openssl rand -hex 32`
and paste the result: `.env` files are read as plain text, so `$(...)` isn't
run.

**Required production values:**

```bash
# Public domain (must point to this server via DNS)
API_DOMAIN=<your API domain>

# TLS certificate email (Let's Encrypt)
CADDY_EMAIL=admin@example.com

# Strong random passwords
COUCHDB_USER=admin
COUCHDB_PASSWORD=<paste: openssl rand -hex 32>

# Allowed CORS origins (your public site)
CORS_ORIGINS=https://roitsystems.ca

# Google sign-in for the admin pages (see GOOGLE_OAUTH_SETUP.md)
GOOGLE_CLIENT_ID=<production client ID>
GOOGLE_CLIENT_SECRET=<production client secret>

# Google accounts allowed into the admin pages (comma-separated, at least one)
ADMIN_EMAILS=admin@example.com

# Signs admin session cookies (at least 32 characters, or the APIs won't start)
SESSION_SECRET=<paste: openssl rand -hex 32>

# Logging level (info for production)
LOG_LEVEL=info

# Rate limiting (adjust as needed)
RATE_LIMIT_MAX=10
RATE_LIMIT_WINDOW_MS=900000

# Optional: notification webhook (for Slack, Signal, Telegram relay)
NOTIFICATION_WEBHOOK_URL=https://your-webhook-url

# NATS cluster URL (internal by default)
NATS_URL=nats://nats:4222

# CouchDB URL (internal by default)
COUCHDB_URL=http://couchdb:5984
```

**Save `SESSION_SECRET`, `GOOGLE_CLIENT_SECRET` and `COUCHDB_PASSWORD` to a secure location.**

### 6. Configure DNS

Point your API domain's A record at the server, and wait for it to resolve.

### 7. Deploy

```bash
./deploy.sh --dry-run   # shows what would be created or recreated, changes nothing
./deploy.sh
```

The first run takes a few minutes while images build and Let's Encrypt issues
a certificate. [DEPLOY.md](DEPLOY.md) explains each check the script makes.

### 8. Verify from outside

```bash
curl https://<your API domain>/health
# Expected: {"status":"ok","ts":"..."}
```

### 9. Test the contact API

```bash
curl -X POST https://<your API domain>/api/contact \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test",
    "email": "test@example.com",
    "message": "Production test"
  }'
```

### 10. Open the admin pages

Open `/corporate-network/contact/admin` on your API domain and sign in with
Google, using an account listed in `ADMIN_EMAILS`.

---

## Backup & Restore

CouchDB's data is in the `infrastructure` project's `couchdb-data` volume.
Find its full name with:

```bash
docker volume ls | grep couchdb-data
```

### List the databases

```bash
(cd infrastructure && docker compose exec couchdb sh -c \
  'curl -s -u "$COUCHDB_USER:$COUCHDB_PASSWORD" http://localhost:5984/_all_dbs')
```

### Back up the volume

Stop CouchDB first, so the copy is consistent, then start it again:

```bash
(cd infrastructure && docker compose stop couchdb)
docker run --rm \
  -v <couchdb volume>:/data:ro \
  -v /path/to/backup:/backup \
  ubuntu tar czf /backup/couchdb-backup.tar.gz -C /data .
(cd infrastructure && docker compose start couchdb)
```

### Restore

```bash
(cd infrastructure && docker compose stop couchdb)
docker run --rm \
  -v <couchdb volume>:/data \
  -v /path/to/backup:/backup \
  ubuntu tar xzf /backup/couchdb-backup.tar.gz -C /data
(cd infrastructure && docker compose start couchdb)
```

---

## Troubleshooting

Run `docker compose` inside the folder of the project you're looking at:
`infrastructure/` for `caddy`, `nats` and `couchdb`;
`corporate-network/contact-inbox/` for `contact-inbox-api`, `-worker` and
`-notification`; `corporate-network/image-converter/` for
`image-converter-api` and `imagemagick-service`.

### A project won't start

```bash
(cd <folder> && docker compose ps)
(cd <folder> && docker compose logs --tail=100)
```

A "variable is not set" warning means that folder's `.env` is missing a value.
On the server, fix the `.env` and run `./deploy.sh` again. Don't `down -v`.

### Caddy/TLS errors

```bash
(cd infrastructure && docker compose logs caddy)
```

The most common cause is DNS that doesn't point at the server yet. Wait, then
check again.

### API not responding

```bash
(cd corporate-network/contact-inbox && docker compose logs contact-inbox-api)
(cd infrastructure && docker compose logs nats couchdb)
```

### Rate limiting is too strict

Change `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` in
`corporate-network/contact-inbox/.env`, then run `./deploy.sh contact-inbox`.
It recreates only the containers whose settings changed.

### Image conversion not working

```bash
(cd corporate-network/image-converter && docker compose ps)
(cd corporate-network/image-converter && docker compose logs imagemagick-service image-converter-api)
```

---

## Monitoring

### System resources

```bash
htop          # server CPU and memory
docker stats  # per container
```

### Disk space

Docker's default log driver doesn't rotate container logs unless it's set up
to (`max-size` and `max-file` in `/etc/docker/daemon.json`; see Docker's
json-file logging docs). If the disk fills, look first (`docker system df`)
and remove only what you've identified. Never prune volumes.

### Health endpoints

- **API health**: `GET https://<your API domain>/health`
- **CouchDB, NATS**: `(cd infrastructure && docker compose ps)` shows whether they're running

---

## Updating the Stack

```bash
cd /root/roitsystems-infra
./deploy.sh --dry-run
./deploy.sh
```

`deploy.sh` fast-forwards to `origin/main`, then recreates only the
containers whose image or settings changed. Nothing is taken down first, no
volume is removed, and Caddy reloads its configuration without a restart.
See [DEPLOY.md](DEPLOY.md).

---

## Security Checklist

- [ ] `.env` file is in `.gitignore` and never committed
- [ ] `SESSION_SECRET` is a random value of at least 32 characters (`openssl rand -hex 32`)
- [ ] `ADMIN_EMAILS` lists only the people who should be admins
- [ ] `COUCHDB_PASSWORD` is a strong, unique password
- [ ] `API_DOMAIN` points to the correct droplet via DNS
- [ ] HTTPS/TLS is working (`curl https://...` returns valid cert)
- [ ] CouchDB and NATS ports are not exposed (no host port bindings in `docker-compose.yml`)
- [ ] Firewall allows only ports 80 and 443 (via DigitalOcean's cloud firewall or iptables)
- [ ] Sensitive data is redacted from logs
- [ ] Regular backups of CouchDB data
- [ ] Monitor error rates and API latency

---

## Next Steps

- See [DESCRIPTION.md](DESCRIPTION.md) for detailed architecture and design
- See [docs/security.md](docs/security.md) for threat model and mitigations
- See [docs/operations.md](docs/operations.md) for runbooks and incident response
