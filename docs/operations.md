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

So `api.roitsystems.ca` → your droplet IP.

If you prefer a single domain: replace `api` with `infra`.

**Do not proxy through Cloudflare** until you have confirmed TLS works end-to-end. Caddy's ACME challenge fails behind Cloudflare's orange-cloud proxy if you use HTTP-01.

---

## Deployment

```bash
# On the server, as deploy user
git clone https://github.com/morgane-oger/roitsystems-infra.git
cd roitsystems-infra

# Create secrets
cp .env.example .env
nano .env          # fill in real values

# Generate ADMIN_TOKEN
openssl rand -hex 32   # paste into .env

# Start
docker compose up -d --build

# Watch logs
docker compose logs -f
```

### Verify

```bash
# All containers healthy?
docker compose ps

# Public API health
curl https://api.roitsystems.ca/health

# Test a contact submission
curl -X POST https://api.roitsystems.ca/api/contact \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","subject":"Test","message":"Integration test from curl"}'
# Expected: {"success":true}

# Admin UI
open https://api.roitsystems.ca/admin
```

---

## Updating

```bash
git pull
docker compose up -d --build
docker image prune -f   # clean old images
```

---

## Volumes & Persistence

| Volume | Data | Path in Container |
|--------|------|-------------------|
| `couchdb_data` | All contact messages | `/opt/couchdb/data` |
| `nats_data` | JetStream message log | `/data` |
| `caddy_data` | TLS certificates | `/data` |
| `caddy_config` | Caddy internal config | `/config` |

Docker named volumes persist across `docker compose down` and image rebuilds. Only `docker compose down -v` removes them.

---

## Backup

### CouchDB

```bash
# One-off backup to a timestamped tar on the host
docker run --rm \
  --volumes-from $(docker compose ps -q couchdb) \
  -v /backup:/backup \
  alpine \
  tar czf /backup/couchdb-$(date +%Y%m%d-%H%M%S).tar.gz /opt/couchdb/data
```

Alternatively, use CouchDB's built-in replication to push to a second CouchDB (e.g., CouchDB Cloud / Cloudant).

### NATS JetStream

```bash
docker run --rm \
  --volumes-from $(docker compose ps -q nats) \
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
  --volumes-from $(docker compose ps -q couchdb) \
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
docker compose stop couchdb

# Restore from backup
docker run --rm \
  --volumes-from $(docker compose ps -q couchdb) \
  -v /backup:/backup \
  alpine \
  sh -c "rm -rf /opt/couchdb/data/* && tar xzf /backup/<filename>.tar.gz -C /"

# Restart
docker compose start couchdb
```

---

## Health Monitoring

```bash
# Quick status
docker compose ps

# Container resource usage
docker stats --no-stream

# API health (set up an uptime monitor with UptimeRobot or Better Stack)
curl https://api.roitsystems.ca/health
```

Set up an external uptime monitor on `https://api.roitsystems.ca/health` for always-on alerting.

---

## Logs

```bash
# All services
docker compose logs -f

# Single service
docker compose logs -f api
docker compose logs -f worker
docker compose logs -f couchdb

# Last 100 lines
docker compose logs --tail=100 api
```

Logs are written to Docker's JSON log driver by default. For persistent log shipping, add a `logging:` section to `docker-compose.yml` pointing to your log aggregator.

---

## Common Operations

```bash
# Restart a single service
docker compose restart api

# Rebuild and restart after a code change
docker compose up -d --build api

# Open a shell in the API container
docker compose exec api sh

# Inspect CouchDB directly (from inside the network)
docker compose exec api curl -s http://couchdb:5984/contact_messages/_all_docs?include_docs=true

# Check NATS stream info
docker compose exec nats nats stream info CONTACT_MESSAGES -s nats://localhost:4222
```
