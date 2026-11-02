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
| `COUCHDB_USER` | CouchDB admin username |
| `COUCHDB_PASSWORD` | CouchDB admin password (make it strong) |
| `CORS_ORIGINS` | Comma-separated allowed origins, e.g. `https://roitsystems.ca` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in for the admin pages (see [GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md)) |
| `ADMIN_EMAILS` | Comma-separated Google accounts allowed in as admins; the APIs won't start without at least one |
| `SESSION_SECRET` | Signs admin session cookies; at least 32 characters (`openssl rand -hex 32`), or the APIs won't start |
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
| `GET` | `/api/admin/messages` | Admin session | List all messages (JSON) |
| `GET` | `/api/admin/messages/:id` | Admin session | Get a single message (JSON) |

### Image Converter
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/corporate-network/image-converter/api/image-jobs` | Admin session (rate-limited) | Submit an image conversion job |
| `GET` | `/corporate-network/image-converter/api/image-jobs/:transaction_id` | Admin session | Poll for job status and result |

### Admin UI
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Liveness check |
| `GET` | `/corporate-network/contact/admin` | Admin session (for its data) | Admin message viewer |
| `GET` | `/corporate-network/image-converter/convert` | Admin session (for its data) | Image converter admin tool |
| `GET` | `/auth/login`, `/auth/callback`, `/auth/logout` | None | Google sign-in and sign-out |

"Admin session" is the `session` cookie set after Google sign-in, for an account
listed in `ADMIN_EMAILS`. A request without one is redirected to
`/auth/login`; a session for any other account gets `403`.

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

Poll `GET /corporate-network/image-converter/api/image-jobs/:transaction_id` with the `transaction_id` above. When `status === "done"`, the response includes `data` (base64-encoded PNG):

```json
{
  "transaction_id": "uuid-here",
  "status": "done",
  "data": "iVBORw0KGgo...base64-encoded-image...",
  "updated_at": "2026-05-08T19:00:15.000Z"
}
```

## Admin access

The admin pages and APIs use Google sign-in. Only the accounts listed in
`ADMIN_EMAILS` get in. Setting up the Google client is described in
[GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md).

### Message Viewer
Open `/corporate-network/contact/admin` on the API domain and sign in with
Google. View all contact messages, their status, and AI-generated insights.

### Image Converter
Open `/corporate-network/image-converter/convert` on the API domain and sign in
with Google. Upload images and convert them using ImageMagick with:
- Format conversion (PNG, JPG, WebP, GIF, TIFF, BMP, etc.)
- Resize with aspect ratio lock
- Rotation, trim, blur, sharpen
- Quality control and color space adjustment
- Batch history tracking

### API Access
The admin APIs accept only the browser session cookie; there are no API tokens.
A session lasts 8 hours, and `/auth/logout` ends it.

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
