# Operations & Deployment

## Recommended Droplet

| | Minimum | Preferred |
|---|---|---|
| vCPU | 1 | 1 |
| RAM | 1 GB | 2 GB |
| Disk | 25 GB SSD | 50 GB SSD |
| OS | Ubuntu 24.04 LTS | Ubuntu 24.04 LTS |

**Estimated cost**: $6–$12/month (DigitalOcean).

---

## Initial Server Setup

```bash
# 1. SSH in as root, create a deploy user
adduser deploy
usermod -aG sudo docker deploy
# (copy your SSH key to /home/deploy/.ssh/authorized_keys)

# 2. Update system
apt update && apt upgrade -y

# 3. Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# 4. Install Docker Compose plugin (comes with Docker CE on Ubuntu 24.04)
docker compose version   # verify

# 5. Configure UFW firewall
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable
ufw status
```

---

## DNS Records

Add these records to your DNS provider (Cloudflare, DigitalOcean DNS, etc.):

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `api` | `<droplet-ip>` | 300 |

So `api.<your domain>` → your droplet IP.

If you prefer a single domain: replace `api` with `infra`.

**Do not proxy through Cloudflare** until you have confirmed TLS works end-to-end. Caddy's ACME challenge fails behind Cloudflare's orange-cloud proxy if you use HTTP-01.

---

## Deployment

```bash
# On the server, as deploy user
git clone https://github.com/morgane-oger/roitsystems-infra.git
cd roitsystems-infra

# Create secrets: one .env, copied (or linked) into each project folder
cp .env.example .env
nano .env          # fill in real values; paste each secret from: openssl rand -hex 32
for d in infrastructure corporate-network/contact-inbox corporate-network/image-converter; do
  cp .env "$d/.env"
done

# Deploy (see DEPLOY.md)
./deploy.sh --dry-run
./deploy.sh

# Watch a project's logs
(cd corporate-network/contact-inbox && docker compose logs -f)
```

Never run `docker compose down -v` or `docker system prune --volumes`: they
delete the CouchDB and NATS data.

### Verify

```bash
# All containers running?
for d in infrastructure corporate-network/contact-inbox corporate-network/image-converter; do
  (cd "$d" && docker compose ps)
done

# Public API health
curl https://$API_DOMAIN/health

# Test a contact submission
curl -X POST https://$API_DOMAIN/api/contact \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","subject":"Test","message":"Integration test from curl"}'
# Expected: {"success":true}

# Admin UI
open https://$API_DOMAIN/corporate-network/contact/admin   # sign in with Google
```

---

## Updating

```bash
./deploy.sh --dry-run   # what would change
./deploy.sh             # fast-forwards to origin/main, recreates only what changed
```

---

## Volumes & Persistence

| Volume | Data | Path in Container |
|--------|------|-------------------|
| `couchdb-data` | All contact messages | `/opt/couchdb/data` |
| `nats-data` | JetStream message log | `/data` |
| `caddy-data` | TLS certificates | `/data` |

All three belong to the `infrastructure/` project; `docker volume ls` shows
their full names. They survive rebuilds and redeploys. `docker compose down -v`
and `docker system prune --volumes` delete them, so never run either.

---

## Backup

### CouchDB

```bash
# One-off backup to a timestamped tar on the host
docker run --rm \
  --volumes-from $(cd infrastructure && docker compose ps -q couchdb) \
  -v /backup:/backup \
  alpine \
  tar czf /backup/couchdb-$(date +%Y%m%d-%H%M%S).tar.gz /opt/couchdb/data
```

Alternatively, use CouchDB's built-in replication to push to a second CouchDB (e.g., CouchDB Cloud / Cloudant).

### NATS JetStream

```bash
docker run --rm \
  --volumes-from $(cd infrastructure && docker compose ps -q nats) \
  -v /backup:/backup \
  alpine \
  tar czf /backup/nats-$(date +%Y%m%d-%H%M%S).tar.gz /data
```

### Automated Daily Backup (cron)

```bash
# /etc/cron.daily/roitsystems-backup
#!/usr/bin/env bash
set -e
cd /home/deploy/roitsystems-infra
docker run --rm \
  --volumes-from $(cd infrastructure && docker compose ps -q couchdb) \
  -v /backup/couchdb:/backup \
  alpine \
  tar czf /backup/couchdb-$(date +%Y%m%d).tar.gz /opt/couchdb/data

# Retain 30 days
find /backup/couchdb -name "*.tar.gz" -mtime +30 -delete
```

---

## Restore

```bash
# Stop services
(cd infrastructure && docker compose stop couchdb)

# Restore from backup
docker run --rm \
  --volumes-from $(cd infrastructure && docker compose ps -q couchdb) \
  -v /backup:/backup \
  alpine \
  sh -c "rm -rf /opt/couchdb/data/* && tar xzf /backup/<filename>.tar.gz -C /"

# Restart
(cd infrastructure && docker compose start couchdb)
```

---

## Health Monitoring

```bash
# Quick status
(cd infrastructure && docker compose ps)
(cd corporate-network/contact-inbox && docker compose ps)
(cd corporate-network/image-converter && docker compose ps)

# Container resource usage
docker stats --no-stream

# API health (set up an uptime monitor with UptimeRobot or Better Stack)
curl https://$API_DOMAIN/health
```

Set up an external uptime monitor on `https://$API_DOMAIN/health` for always-on alerting.

---

## Logs

```bash
# One project's services (run inside its folder)
(cd corporate-network/contact-inbox && docker compose logs -f)

# Single service
(cd corporate-network/contact-inbox && docker compose logs -f contact-inbox-api)
(cd corporate-network/contact-inbox && docker compose logs -f contact-inbox-worker)
(cd infrastructure && docker compose logs -f couchdb)

# Last 100 lines
(cd corporate-network/contact-inbox && docker compose logs --tail=100 contact-inbox-api)
```

Logs are written to Docker's JSON log driver by default. For persistent log shipping, add a `logging:` section to the project's `docker-compose.yml` pointing to your log aggregator.

---

## Common Operations

```bash
# Restart a single service
(cd corporate-network/contact-inbox && docker compose restart contact-inbox-api)

# Rebuild and restart after a code change (merged to main)
./deploy.sh contact-inbox

# Open a shell in the API container
(cd corporate-network/contact-inbox && docker compose exec contact-inbox-api sh)

# Inspect CouchDB directly
(cd infrastructure && docker compose exec couchdb sh -c \
  'curl -s -u "$COUCHDB_USER:$COUCHDB_PASSWORD" "http://localhost:5984/contact_messages/_all_docs?include_docs=true"')

# Check NATS stream info (the nats image has no shell or CLI, so use a throwaway
# nats-box container on the internal network, with a NATS user from nats.conf)
read -rs NATS_PASSWORD && export NATS_PASSWORD     # not echoed, not in the history
docker run --rm --network corporate-backend -e NATS_USER=<nats user> -e NATS_PASSWORD \
  natsio/nats-box:0.17.0 nats -s nats://nats:4222 stream info CONTACT_MESSAGES
unset NATS_PASSWORD
```
