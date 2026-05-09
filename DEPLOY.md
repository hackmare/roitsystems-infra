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

Edit `.env` and set:
- `API_DOMAIN` — your public domain (e.g., `api.roitsystems.ca`)
- `CADDY_EMAIL` — email for Let's Encrypt certificate renewal
- `COUCHDB_USER` and `COUCHDB_PASSWORD` — strong credentials
- `ADMIN_TOKEN` — generate with `openssl rand -hex 32`
- `CLAUDE_API_KEY` — from console.anthropic.com
- `RESEND_API_KEY` — from resend.com
- All other secrets

**⚠️ Security**: Never commit `.env` to version control. It's in `.gitignore`.

### 2. Deploy Locally (for testing)

```bash
./deploy.sh
```

This will:
1. Validate `.env` exists
2. Kill and clean old containers
3. Start infrastructure (Caddy, NATS, CouchDB)
4. Wait 15 seconds for CouchDB to initialize
5. Start contact-inbox app
6. Start image-converter app

### 3. Verify Deployment

```bash
# Check all containers are running
docker ps

# Test the health endpoint
curl http://localhost/health

# Check logs (example)
docker logs infrastructure_caddy_1
docker logs contact-inbox-api
```

### 4. Deploy to Production

On the target machine (e.g., production droplet):

```bash
# SSH into the server
ssh root@pubapi.roitsystems.ca

# Clone or update the repository
cd /root/roitsystems-infra
git pull origin main

# Copy .env (already there from previous setup) or create new one
# Ensure all variables are set:
# - For HTTPS: API_DOMAIN and CADDY_EMAIL must be configured
# - For services: CLAUDE_API_KEY, RESEND_API_KEY, etc.

# Deploy
./deploy.sh
```

## Configuration Details

### Required Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `API_DOMAIN` | Public hostname | `api.roitsystems.ca` |
| `CADDY_EMAIL` | TLS certificate email | `m.oger@roitsystems.ca` |
| `COUCHDB_USER` | Database admin | `admin` |
| `COUCHDB_PASSWORD` | Database password | `[strong password]` |
| `ADMIN_TOKEN` | API auth token | `[32-byte hex]` |
| `CLAUDE_API_KEY` | Claude API access | From console.anthropic.com |
| `RESEND_API_KEY` | Email service | From resend.com |
| `NOTIFICATION_EMAIL` | Recipient email | `m.oger@roitsystems.ca` |
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

Once deployed, test these endpoints:

```bash
# Health check (should return 200)
curl https://api.roitsystems.ca/health

# Contact form submission (should return 202)
curl -X POST https://api.roitsystems.ca/corporate-network/contact \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","message":"Hi"}'

# Contact admin (requires ADMIN_TOKEN)
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.roitsystems.ca/corporate-network/contact/admin

# Image converter admin (requires ADMIN_TOKEN)
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.roitsystems.ca/corporate-network/image-converter/convert
```

## Rollback

To revert to a previous version:

```bash
git log --oneline | head -5
git checkout [commit-hash]
./deploy.sh
```

## Next Steps

1. ✅ Run `./deploy.sh` locally to validate configuration
2. ✅ Test all endpoints from "Health Checks" above
3. ✅ Push `.env` securely to production machine (outside of git)
4. ✅ Run `./deploy.sh` on production
5. ⬜ Implement Google Workspace OAuth (deferred)
6. ⬜ Set up monitoring and alerting
