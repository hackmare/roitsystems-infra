# roitsystems-infra

Private message-ingestion infrastructure for [roitsystems.ca](https://roitsystems.ca).

**Stack**: Caddy · CouchDB · NATS JetStream · Node.js/TypeScript API · Node.js Worker  
**Deployment**: Docker Compose on a DigitalOcean droplet

---

## What this does

1. **Contact Ingestion**: Accepts contact-form submissions from roitsystems.ca via a secure HTTPS API.
2. **Message Storage**: Stores each message durably in CouchDB.
3. **AI Analysis**: Worker processes messages asynchronously via NATS, calling Claude API for intelligent analysis (company research, competitive insights, market timing).
4. **Notifications**: Sends email summaries via Resend with extracted intelligence and recommendations.
5. **Image Conversion**: Internal admin tool for converting images with ImageMagick (PNG, JPG, WebP, GIF, TIFF) with advanced parameters.
6. **Admin Dashboard**: Private UI for managing messages and image conversions.

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
| `CORPORATE_NETWORK_AUTH_USER` | Username for the `/corporate-network` HTTP Basic auth gate |
| `CORPORATE_NETWORK_AUTH_HASH` | Caddy hashed password for the `/corporate-network` HTTP Basic auth gate |
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

### Contact Messages
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/contact` | None (rate-limited) | Submit a contact message |
| `GET` | `/api/admin/messages` | Bearer token | List all messages (JSON) |
| `GET` | `/api/admin/messages/:id` | Bearer token | Get a single message (JSON) |

### Image Converter
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/admin/image-jobs` | Bearer token (rate-limited) | Submit an image conversion job |
| `GET` | `/api/admin/image-jobs/:transaction_id` | Bearer token | Poll for job status and result |

### Admin UI
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Liveness check |
| `GET` | `/admin` | Token (browser UI) | Admin message viewer |
| `GET` | `/admin/image-convert` | Token (browser UI) | Image converter admin tool |

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

## Image conversion job payload

```json
{
  "params": {
    "format": "webp",
    "quality": 85,
    "width": 1200,
    "height": 630,
    "rotate": 0,
    "trim": false,
    "colorspace": "sRGB",
    "background": "#ffffff",
    "flatten": false,
    "density": 72,
    "blur": 0,
    "sharpen": 0
  }
}
```

Multipart form data: field `file` contains the binary image, field `params` contains the JSON above (stringified). Response:

```json
{
  "transaction_id": "uuid-here",
  "status": "queued",
  "params": {...},
  "filename": "original-filename.png",
  "created_at": "2026-05-08T19:00:00.000Z",
  "updated_at": "2026-05-08T19:00:00.000Z"
}
```

Poll `GET /api/admin/image-jobs/:transaction_id` with the `transaction_id` above. When `status === "done"`, the response includes `data` (base64-encoded PNG):

```json
{
  "transaction_id": "uuid-here",
  "status": "done",
  "data": "iVBORw0KGgo...base64-encoded-image...",
  "updated_at": "2026-05-08T19:00:15.000Z"
}
```

## Admin access

All `/corporate-network` pages and tools are protected by Caddy HTTP Basic auth before the application UIs load. Generate the password hash with:

```bash
docker run --rm caddy:2 caddy hash-password --plaintext 'your-strong-password'
```

Set `CORPORATE_NETWORK_AUTH_USER` and `CORPORATE_NETWORK_AUTH_HASH` in `.env`, then deploy/reload Caddy.

### Message Viewer
Open `https://api.roitsystems.ca/admin` in your browser and enter the `ADMIN_TOKEN`. View all contact messages, their status, and AI-generated insights.

### Image Converter
Open `https://api.roitsystems.ca/admin/image-convert` in your browser and enter the `ADMIN_TOKEN`. Upload images and convert them using ImageMagick with:
- Format conversion (PNG, JPG, WebP, GIF, TIFF, BMP, etc.)
- Resize with aspect ratio lock
- Rotation, trim, blur, sharpen
- Quality control and color space adjustment
- Batch history tracking

### API Access
```bash
# List messages
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://api.roitsystems.ca/api/admin/messages

# Get a single message
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://api.roitsystems.ca/api/admin/messages/{message_id}

# Submit image conversion job
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "file=@image.png" \
  -F "params={\"format\":\"webp\",\"quality\":85}" \
  https://api.roitsystems.ca/api/admin/image-jobs

# Poll for job status
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.roitsystems.ca/api/admin/image-jobs/{transaction_id}
```

## Documentation

- [Architecture](docs/architecture.md)
- [Security](docs/security.md)
- [Operations & Deployment](docs/operations.md)

## Repository layout

```
roitsystems-infra/
  docker-compose.yml           # all services
  .env.example                 # configuration template
  caddy/Caddyfile              # reverse proxy + TLS config
  nats/nats.conf               # JetStream config
  api/                         # contact API + image converter (TypeScript/Fastify)
    src/
      admin-image-convert.html # image converter admin UI
  worker/                      # contact message processor (TypeScript)
  imagemagick-service/         # image conversion worker (Node.js)
  scripts/
    init-couchdb.sh            # manual DB initialisation helper
    healthcheck.sh             # post-deploy health verification
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
