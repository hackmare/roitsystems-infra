# roitsystems-infra

Private message-ingestion infrastructure for [roitsystems.ca](https://roitsystems.ca).

**Stack**: Caddy · CouchDB · NATS JetStream · Node.js/TypeScript API · Node.js Worker  
**Deployment**: Docker Compose on a DigitalOcean droplet

---

## What this does

1. Accepts contact-form submissions from roitsystems.ca via a secure HTTPS API.
2. Stores each message durably in CouchDB.
3. Publishes an event to NATS JetStream so the worker can process it asynchronously.
4. Worker marks messages as processed and fires an optional notification webhook.
5. Private admin UI lists all messages with status.

## Quick start (local)

```bash
git clone https://github.com/morgane-oger/roitsystems-infra.git
cd roitsystems-infra
cp .env.example .env
# Edit .env with your values (see below)

docker compose up -d --build
```

## .env values

| Variable | Description |
|----------|-------------|
| `API_DOMAIN` | Public hostname, e.g. `api.roitsystems.ca` |
| `CADDY_EMAIL` | Email for Let's Encrypt TLS cert |
| `COUCHDB_USER` | CouchDB admin username |
| `COUCHDB_PASSWORD` | CouchDB admin password (make it strong) |
| `CORS_ORIGINS` | Comma-separated allowed origins, e.g. `https://roitsystems.ca` |
| `ADMIN_TOKEN` | Secret for the admin API — generate with `openssl rand -hex 32` |
| `RATE_LIMIT_MAX` | Max contact submissions per window per IP (default: 10) |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window in ms (default: 900000 = 15 min) |
| `NOTIFICATION_WEBHOOK_URL` | Optional webhook for notifications (Signal/Telegram relay) |
| `LOG_LEVEL` | `info` in production, `debug` for troubleshooting |

**Never commit `.env` to git.** The `.gitignore` already excludes it.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/contact` | None (rate-limited) | Submit a contact message |
| `GET` | `/health` | None | Liveness check |
| `GET` | `/admin` | Token (browser UI) | Admin message viewer |
| `GET` | `/api/admin/messages` | Bearer token | List all messages (JSON) |
| `GET` | `/api/admin/messages/:id` | Bearer token | Get a single message (JSON) |

## Contact form payload

```json
{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "company": "Acme Corp",
  "subject": "AI Readiness Assessment",
  "message": "We need help with...",
  "budget": "$15,000–$35,000",
  "timeline": "This quarter",
  "source_page": "https://roitsystems.ca/#contact",
  "timestamp": "2026-04-26T18:00:00.000Z",
  "consent": true,
  "hp": ""
}
```

`hp` is the honeypot field — must be empty. `company`, `budget`, `timeline`, `source_page`, `timestamp`, and `consent` are optional.

## Admin access

Open `https://api.roitsystems.ca/admin` in your browser and enter the `ADMIN_TOKEN`.

For API access:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://api.roitsystems.ca/api/admin/messages
```

## Documentation

- [Architecture](docs/architecture.md)
- [Security](docs/security.md)
- [Operations & Deployment](docs/operations.md)

## Repository layout

```
roitsystems-infra/
  docker-compose.yml     # all services
  .env.example           # configuration template
  caddy/Caddyfile        # reverse proxy + TLS config
  nats/nats.conf         # JetStream config
  api/                   # contact API (TypeScript/Fastify)
  worker/                # JetStream consumer (TypeScript)
  scripts/
    init-couchdb.sh      # manual DB initialisation helper
    healthcheck.sh       # post-deploy health verification
  docs/
    architecture.md
    security.md
    operations.md
```

## Acceptance criteria

- [x] `docker compose up -d` starts the full stack
- [x] HTTPS works on the public API domain (via Caddy + Let's Encrypt)
- [x] `POST /api/contact` accepts and validates messages
- [x] Messages stored durably in CouchDB
- [x] NATS JetStream event published on each submission
- [x] Worker consumes events and updates message status
- [x] CouchDB and NATS not publicly reachable (no host port bindings)
- [x] Admin UI lists messages with status
- [x] No secrets committed to git
