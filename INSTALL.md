# Installation & Deployment

## Prerequisites

- **Docker** 20.10+ and **Docker Compose** 1.29+
  - [Install Docker Desktop](https://www.docker.com/products/docker-desktop) (includes both)
  - On Linux: `apt install docker.io docker-compose` or use [Docker's official installer](https://docs.docker.com/engine/install/)
- **A public domain** with DNS control (e.g., `api.roitsystems.ca`)
- **DigitalOcean droplet** (or any VPS) with 2GB+ RAM, Ubuntu 20.04+
- **Git** for cloning the repository
- **OpenSSL** for generating secure tokens (usually pre-installed)

## Local Development Setup

### 1. Clone the repository

```bash
git clone https://github.com/morgane-oger/roitsystems-infra.git
cd roitsystems-infra
```

### 2. Create `.env` from template

```bash
cp .env.example .env
```

### 3. Edit `.env` with local values

```bash
# .env (for localhost testing)
API_DOMAIN=localhost:3000
CADDY_EMAIL=dev@example.com
COUCHDB_USER=admin
COUCHDB_PASSWORD=devpassword
CORS_ORIGINS=http://localhost:3000
ADMIN_TOKEN=dev-token-12345
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=900000
LOG_LEVEL=debug
```

### 4. Start the stack

```bash
docker compose up -d --build
```

Monitor startup:

```bash
docker compose logs -f api
```

Wait for: `Server listening on 0.0.0.0:3000`

### 5. Verify health

```bash
curl http://localhost:3000/health
# Expected: {"status":"ok","ts":"2026-05-08T..."}
```

### 6. Test the contact API

```bash
curl -X POST http://localhost:3000/api/contact \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "message": "Hello world"
  }'
```

### 7. Access admin panel

- Open **http://localhost:3000/admin** in your browser
- Enter `ADMIN_TOKEN` from `.env`
- Should see message list (empty on first run)

---

## Production Deployment (DigitalOcean)

### 1. Create a droplet

- **Image**: Ubuntu 20.04 x64
- **Size**: $12/mo (2GB RAM, 50GB SSD) minimum
- **Region**: Choose closest to your users
- **Enable monitoring** and backups (optional)

### 2. SSH into the droplet

```bash
ssh root@<your-droplet-ip>
```

### 3. Install Docker and Docker Compose

```bash
# Update packages
apt update && apt upgrade -y

# Install Docker
apt install -y docker.io docker-compose

# Start Docker daemon
systemctl start docker
systemctl enable docker

# Add current user to docker group (optional, for non-root usage)
usermod -aG docker root
```

### 4. Clone and configure

```bash
cd /root
git clone https://github.com/morgane-oger/roitsystems-infra.git
cd roitsystems-infra
```

### 5. Create production `.env`

```bash
nano .env  # or use your preferred editor
```

**Required production values:**

```bash
# Public domain (must point to this droplet's IP via DNS)
API_DOMAIN=api.roitsystems.ca

# TLS certificate email (Let's Encrypt)
CADDY_EMAIL=admin@roitsystems.ca

# Strong random passwords
COUCHDB_USER=admin
COUCHDB_PASSWORD=$(openssl rand -hex 32)

# Allowed CORS origins (your public site)
CORS_ORIGINS=https://roitsystems.ca

# Strong admin token (for accessing /admin and /api/admin/*)
ADMIN_TOKEN=$(openssl rand -hex 32)

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

**Save the `ADMIN_TOKEN` and `COUCHDB_PASSWORD` to a secure location.**

### 6. Configure DNS

Point your domain's A record to the droplet IP:

```
api.roitsystems.ca  A  <droplet-ip>
```

Wait 5–10 minutes for DNS propagation.

### 7. Start the stack

```bash
docker compose up -d --build
```

**First run may take 2–3 minutes while services initialize and Let's Encrypt provisions a certificate.**

### 8. Monitor startup

```bash
docker compose logs -f api
docker compose logs -f caddy
```

Wait for both to report readiness.

### 9. Verify from outside

```bash
curl https://api.roitsystems.ca/health
# Expected: {"status":"ok","ts":"..."}
```

If DNS hasn't propagated yet, use the droplet IP:

```bash
curl --cacert /dev/null \
  -H "Host: api.roitsystems.ca" \
  https://<droplet-ip>/health
```

### 10. Test contact API

```bash
curl -X POST https://api.roitsystems.ca/api/contact \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test",
    "email": "test@example.com",
    "message": "Production test"
  }'
```

### 11. Access admin panel

Open **https://api.roitsystems.ca/admin** and enter your `ADMIN_TOKEN`.

---

## Backup & Restore

### Backup CouchDB data

```bash
docker compose exec couchdb curl -X GET \
  http://localhost:5984/_all_dbs \
  -u $COUCHDB_USER:$COUCHDB_PASSWORD
```

For full database backup, use CouchDB's native replication API or Docker volume snapshots:

```bash
# Backup volumes
docker run --rm \
  -v roitsystems-infra_couchdb-data:/data \
  -v /path/to/backup:/backup \
  ubuntu tar czf /backup/couchdb-backup.tar.gz -C /data .
```

### Restore from backup

```bash
docker run --rm \
  -v roitsystems-infra_couchdb-data:/data \
  -v /path/to/backup:/backup \
  ubuntu tar xzf /backup/couchdb-backup.tar.gz -C /data
```

---

## Troubleshooting

### Docker Compose won't start

```bash
# Clear old state
docker compose down -v

# Rebuild everything
docker compose up -d --build

# Check logs
docker compose logs
```

### Caddy/TLS errors

```bash
docker compose logs caddy

# Common issue: DNS not resolved yet
# Wait 5–10 minutes and try again, or temporarily use:
curl http://localhost:80/health  # via Caddy without TLS
```

### API not responding

```bash
docker compose ps

# All services should show "Up"
# If any are down, check logs:
docker compose logs api
docker compose logs nats
docker compose logs couchdb
```

### CouchDB connection errors

```bash
# Test CouchDB directly
curl http://localhost:5984/_up \
  -u admin:password

# Check container
docker compose logs couchdb
```

### Rate limiting is too strict

Adjust in `.env`:

```bash
RATE_LIMIT_MAX=20           # requests per window
RATE_LIMIT_WINDOW_MS=600000 # 10 minutes
```

Then restart:

```bash
docker compose restart api
```

### Image conversion not working

1. Check ImageMagick service is running:

```bash
docker compose ps imagemagick
```

2. Check NATS connectivity:

```bash
docker compose logs imagemagick
```

3. Verify image file is readable:

```bash
docker compose exec imagemagick identify /tmp/test.png
```

---

## Monitoring & Alerts

### Check system resources

```bash
# Droplet CPU/memory
htop

# Docker container stats
docker stats
```

### Log rotation

Docker automatically rotates logs. To manually clean old logs:

```bash
docker system prune -a --volumes
```

### Health endpoints

- **API health**: `GET https://api.roitsystems.ca/health`
- **CouchDB health**: `GET http://localhost:5984/_up` (internal)
- **NATS health**: Check container logs

---

## Updating the Stack

### Pull latest code

```bash
cd /root/roitsystems-infra
git pull origin main
```

### Rebuild and restart

```bash
docker compose up -d --build
```

### Zero-downtime deployments

1. Start new container: `docker compose up -d`
2. Caddy automatically health-checks and switches traffic
3. Old container is replaced once healthy

---

## Security Checklist

- [ ] `.env` file is in `.gitignore` and never committed
- [ ] `ADMIN_TOKEN` is a cryptographically random 64-character hex string
- [ ] `COUCHDB_PASSWORD` is a strong, unique password
- [ ] `API_DOMAIN` points to the correct droplet via DNS
- [ ] HTTPS/TLS is working (`curl https://...` returns valid cert)
- [ ] CouchDB and NATS ports are not exposed (no host port bindings in `docker-compose.yml`)
- [ ] Firewall allows only ports 80 and 443 (via DigitalOcean's cloud firewall or iptables)
- [ ] Logs are rotated and sensitive data is redacted
- [ ] Regular backups of CouchDB data
- [ ] Monitor error rates and API latency

---

## Next Steps

- See [DESCRIPTION.md](DESCRIPTION.md) for detailed architecture and design
- See [docs/security.md](docs/security.md) for threat model and mitigations
- See [docs/operations.md](docs/operations.md) for runbooks and incident response
