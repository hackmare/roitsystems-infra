# Architecture & Design

## System Overview

**roitsystems-infra** is a private message-ingestion platform for capturing, analyzing, and processing contact submissions from roitsystems.ca. It combines:

- **Contact form intake** with rate limiting and validation
- **AI analysis** using Claude API (company research, competitive intelligence, market timing)
- **Email notifications** with Resend
- **Image conversion** via ImageMagick (async NATS-backed job queue)
- **Admin dashboard** for message and image conversion management

All backed by **durable storage** (CouchDB), **event streaming** (NATS JetStream), and **containerized deployment** (Docker Compose).

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      Public Internet                             │
└────────────────┬────────────────────────────────────────────────┘
                 │ HTTPS
                 ▼
        ┌────────────────┐
        │  Caddy Proxy   │  (TLS termination, reverse proxy)
        │  (port 80/443) │
        └────────┬───────┘
                 │
         ┌───────┴──────────────────────────┐
         │                                   │
         ▼                                   ▼
    ┌─────────────────┐           ┌──────────────────────┐
    │  Fastify API    │           │  Admin UI (browser)  │
    │  (port 3000)    │           │  /admin              │
    │                 │           │  /admin/image-convert│
    │ Routes:         │           └──────────────────────┘
    │  POST /contact  │
    │  GET /health    │
    │  /api/admin/*   │
    │  /admin/*       │
    └────────┬────────┘
             │
        ┌────┴─────────────────────────┬─────────────┐
        │                              │             │
        ▼                              ▼             ▼
   ┌─────────────┐              ┌──────────────┐   ┌────────────────┐
   │  CouchDB    │              │ NATS Stream  │   │ Node Worker    │
   │ (port 5984) │              │ (port 4222)  │   │ (TypeScript)   │
   │             │              │              │   │                │
   │ Databases:  │              │ Streams:     │   │ Listens on:    │
   │  messages   │              │  CONTACT_*   │   │  contact.new   │
   │  image_jobs │              │  IMAGE_*     │   │  image.ready   │
   │  bot_state  │              │              │   │                │
   └─────────────┘              └──────────────┘   │ Calls Claude   │
        ▲                             ▲            │ API            │
        │                             │            │ Sends email    │
        │ Persist                     │ Publish    │ via Resend     │
        │ queries                     │ events     └────────────────┘
        │                             │
    ┌───┴────────────────────────────┴────────┐
    │                                          │
    │  Internal Service Network                │
    │  (no port bindings to host)              │
    │                                          │
    └──────────────────────────────────────────┘
             │
             │  image.convert
             ▼
    ┌─────────────────────────┐
    │ ImageMagick Worker      │
    │ (Node.js + execFile)    │
    │                         │
    │ Listens: image.convert  │
    │ Publishes: image.ready  │
    │                         │
    │ Calls ImageMagick CLI   │
    └─────────────────────────┘
```

---

## Component Responsibilities

### **Caddy** (Reverse Proxy & TLS)
- Terminates HTTPS/TLS on ports 80 and 443
- Routes traffic to Fastify API
- Provisions Let's Encrypt certificates automatically
- No backend storage; restarts safely
- **Stateless**

### **Fastify API** (TypeScript)
- Accepts contact form submissions via `POST /api/contact`
- Validates input (name, email, message required; honeypot field empty)
- Rate-limits requests per IP
- Stores contact messages in CouchDB
- Publishes events to NATS `contact.messages.new`
- Exposes admin API (`/api/admin/*`)
- Serves admin UI pages (`/admin`, `/admin/image-convert`)
- Handles image conversion job submission and status polling
- **Stateless** (except for in-flight requests)

### **CouchDB** (Document Store)
- Durably stores contact messages with full history
- Durably stores image conversion job metadata and results
- Durably stores bot state (for retry logic and deduplication)
- Supports revision-based concurrency control (`_rev`)
- Database is auto-created on first API startup
- **Stateful** — requires backup strategy

### **NATS JetStream** (Event Streaming)
- Publishes and subscribes to two streams:
  - **CONTACT_MESSAGES** — events for new submissions, processing updates
  - **IMAGE_JOBS** — image conversion requests and completions
- Provides at-least-once delivery guarantees
- Durable consumer groups for replay and durability
- 30-day retention for contact messages; 7-day for image jobs
- **Stateful** — retains events in file storage
- **Internal network only** — not exposed to public

### **Node Worker** (TypeScript)
- Subscribes to `contact.messages.new` events from NATS
- Polls CouchDB for the full message document
- Calls Claude API for AI analysis (company research, competitive insights)
- Updates message status in CouchDB (`analyzing` → `done`)
- Sends email notification via Resend with intelligence summary
- Handles errors and retries with exponential backoff
- **Stateless** — except for in-flight processing state

### **ImageMagick Worker** (Node.js)
- Subscribes to `image.convert` NATS events
- Receives image filename and ImageMagick parameters
- Calls `convert` CLI with requested transformations
- Encodes result as base64 PNG
- Publishes `image.ready` event with result data
- Updates CouchDB job document with status and result
- Cleans up temp files
- **Stateless** — processes one job at a time

---

## Data Flow

### Contact Message Submission

```
1. Browser submits contact form to https://api.roitsystems.ca/api/contact
2. Fastify validates input (Zod schema)
3. Fastify rate-limits by IP
4. Fastify generates unique _id (UUID)
5. Fastify stores doc in CouchDB: { _id, name, email, message, status: 'submitted', ... }
6. Fastify publishes event to NATS: { type: 'contact.new', message_id, timestamp }
7. Fastify returns 201 with message_id
8. Browser redirects to confirmation page
9. Worker subscribes to 'contact.messages.new', receives event
10. Worker fetches full message from CouchDB
11. Worker calls Claude API for analysis
12. Worker updates CouchDB doc: { status: 'analyzed', intelligence: {...} }
13. Worker publishes internal event (for UI updates)
14. Worker sends email via Resend to admin@roitsystems.ca
```

### Image Conversion Job

```
1. Admin UI submits job: POST /api/admin/image-jobs with file + params
2. Fastify validates Bearer token
3. Fastify generates transaction_id (UUID)
4. Fastify stores file in temp location or as base64
5. Fastify stores job doc in CouchDB: { _id: transaction_id, status: 'queued', params, filename }
6. Fastify publishes event to NATS: { transaction_id, type: 'image.convert', params }
7. Fastify returns 202 with transaction_id
8. ImageMagick worker receives 'image.convert' event
9. Worker downloads image file (from shared storage or embedded in message)
10. Worker calls: convert input.png -format webp -quality 85 output.webp
11. Worker encodes result as base64
12. Worker publishes 'image.ready': { transaction_id, data: base64 }
13. Worker updates CouchDB: { _id: transaction_id, status: 'done', data: base64, ... }
14. Admin UI polls GET /api/admin/image-jobs/:transaction_id
15. Frontend detects status === 'done', displays preview, shows download button
16. User clicks download → browser decodes base64 and saves file
```

---

## Technology Choices & Rationale

| Component | Choice | Why |
|-----------|--------|-----|
| **Container Runtime** | Docker Compose | Single-server deployment, simple networking, easy local dev |
| **Reverse Proxy** | Caddy | Auto TLS renewal, minimal config, good defaults |
| **API Framework** | Fastify | Fast, TypeScript-friendly, built-in plugin ecosystem |
| **Validation** | Zod | Type-safe schemas, good error messages |
| **Database** | CouchDB | JSON document model, built-in replication, HTTP API (no client lib needed) |
| **Event Streaming** | NATS JetStream | Lightweight, durable, simple pub/sub, good for small teams |
| **Language** | TypeScript | Type safety across services, catches errors early |
| **Image Processing** | ImageMagick CLI | No FFmpeg size overhead, most formats supported, battle-tested |
| **Email** | Resend | Transactional only, no SMTP server, webhooks for bounces |
| **AI Analysis** | Claude API | Best reasoning model, company research capability |

---

## API Design Patterns

### Authentication
- **Bearer token** in `Authorization` header
- Token is a 64-character hex string (256 bits)
- No JWT — just opaque secret, validated against `ADMIN_TOKEN` env var
- Scoped to `/api/admin/*` and `/admin` routes only

### Rate Limiting
- **Per-IP, sliding window** via @fastify/rate-limit
- Contact form: configurable (default 10 requests per 15 min)
- Image jobs: 30 requests per 15 min per IP
- Returns `429 Too Many Requests` with error message

### Error Responses
```json
{
  "error": "Human-readable message",
  "status": 400
}
```

### Async Job Pattern
- **Immediate response** with `transaction_id`
- **Polling for status** with configurable interval (default 15 sec)
- **Result in status response** once complete (`status === "done"`)
- Avoids WebSocket complexity; works in browsers without special config

### Database Revisions
- CouchDB requires `_rev` in PUT requests for updates
- Service layer hides this from API consumers
- Prevents lost-update anomalies with concurrent edits

---

## Event Model

### NATS Streams

**CONTACT_MESSAGES**
- Subject: `contact.messages.new`
- Payload: `{ type: 'contact.new', message_id: UUID, timestamp: ISO8601 }`
- Retention: 30 days
- Consumer: Node Worker

**IMAGE_JOBS**
- Subjects: `image.convert`, `image.ready`
- Payload (convert): `{ transaction_id: UUID, type: 'image.convert', params: {...} }`
- Payload (ready): `{ transaction_id: UUID, data: base64 }`
- Retention: 7 days
- Consumers: ImageMagick Worker, API (for status updates)

### Event Ordering
- NATS guarantees **per-subject ordering** (FIFO within a subject)
- Cross-subject ordering is not guaranteed
- Transaction IDs ensure correlation across streams

---

## Database Schema

### `contact_messages` Collection
```json
{
  "_id": "uuid-here",
  "_rev": "1-abc123def456...",
  "type": "contact_message",
  "name": "Jane Smith",
  "email": "jane@example.com",
  "company": "Acme Corp",
  "subject": "AI Readiness",
  "message": "We need help...",
  "budget": "$15k–$35k",
  "timeline": "Q2 2026",
  "source_page": "https://roitsystems.ca/#contact",
  "consent": true,
  "status": "analyzed",
  "intelligence": {
    "company_profile": "Acme Corp is a...",
    "needs_analysis": "They need AI for...",
    "product_fit": "We should propose...",
    "recommended_next_steps": "Schedule discovery call..."
  },
  "created_at": "2026-05-08T19:00:00.000Z",
  "updated_at": "2026-05-08T19:00:15.000Z",
  "email_sent_at": "2026-05-08T19:00:20.000Z"
}
```

### `image_jobs` Collection
```json
{
  "_id": "transaction-id-uuid",
  "_rev": "2-xyz789...",
  "type": "image_job",
  "transaction_id": "transaction-id-uuid",
  "status": "done",
  "filename": "product-screenshot.png",
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
  },
  "data": "iVBORw0KGgoAAAANSUhEUgAA...",
  "created_at": "2026-05-08T19:00:00.000Z",
  "updated_at": "2026-05-08T19:00:05.000Z"
}
```

### `bot_state` Collection
Used for deduplication and retry state:
```json
{
  "_id": "message-id-uuid",
  "_rev": "1-...",
  "type": "bot_processing_state",
  "status": "completed",
  "last_attempt": "2026-05-08T19:00:15.000Z",
  "retry_count": 0
}
```

---

## Error Handling & Resilience

### Contact Submission
- **Validation errors**: Return 400 immediately
- **Rate limit exceeded**: Return 429
- **Database unreachable**: Return 503 (Server Unavailable)
- **NATS unreachable**: Return 500 (internal error after message saved)

### Worker Processing
- **Claude API timeout**: Exponential backoff, max 5 retries
- **Email send failure**: Log error, mark status as `analyzed_no_email`
- **Duplicate processing**: Check `bot_state` before processing
- **Corrupt message doc**: Log and skip (don't crash the consumer)

### Image Conversion
- **File too large**: Return 413 immediately
- **Invalid format**: Return 400 with error message
- **ImageMagick crash**: Catch and publish `image.ready` with error status
- **Temp file cleanup**: Always run in `finally` block

### Recovery Strategies
- **NATS durable consumers**: Automatically replay events on restart
- **CouchDB durability**: All writes are fsynced; survives process crash
- **Health checks**: Caddy and admin UI periodically check `/health`
- **Graceful shutdown**: API drains in-flight requests before exiting

---

## Security Model

### Network Isolation
- **Public**: Only Caddy ports (80, 443) are exposed
- **Internal**: CouchDB, NATS, Worker only accessible within container network
- **DigitalOcean Firewall**: Restrict SSH (port 22) to known IPs

### Authentication
- **Admin API**: Bearer token in env var, non-guessable
- **Contact form**: No auth required; rate-limiting provides DOS protection
- **Browser admin UI**: Token stored in `sessionStorage`; sent as `Authorization` header

### Data Protection
- **PII in logs**: Redacted by Fastify logger (`email`, `name` fields)
- **HTTPS/TLS**: Automatic renewal via Let's Encrypt
- **Database**: No encryption at rest (consider adding with full-disk encryption on VPS)

### Input Validation
- **Contact form**: Zod schema validates types and lengths
- **Honeypot**: Empty field submission triggers validation error
- **File uploads**: Max 50MB, MIME type checked
- **Parameters**: Numeric ranges validated (quality 1–100, density > 0)

---

## Deployment Considerations

### Single Server
- All services on one droplet simplifies networking and secrets management
- Single point of failure (acceptable for a sales intake tool)
- Vertical scaling only (upgrade droplet size if needed)

### Multi-Server (Future)
- Split database to managed CouchDB (e.g., Couchbase Cloud)
- Move NATS to separate droplet or managed service (e.g., Synadia Cloud)
- Run API and Worker replicas behind load balancer
- Share secrets via HashiCorp Vault or AWS Secrets Manager

### Backups
- CouchDB volumes should be backed up daily
- NATS data is ephemeral (events retain 7–30 days)
- Archive old messages quarterly to S3 or archive storage

---

## Testing & Monitoring

### Local Testing
```bash
# Health check
curl http://localhost:3000/health

# Submit contact message
curl -X POST http://localhost:3000/api/contact \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","message":"Test"}'

# List messages (with admin token)
curl -H "Authorization: Bearer dev-token" \
  http://localhost:3000/api/admin/messages
```

### Production Monitoring
- **Docker logs**: `docker logs <container>`
- **CPU/memory**: `docker stats`
- **Database health**: CouchDB `/_up` endpoint
- **Event latency**: Check timestamps in CouchDB docs

---

## Future Enhancements

1. **Multi-tenant support**: Prefix database/stream names by tenant
2. **Message search**: Add Elasticsearch for full-text search
3. **Webhooks**: Allow users to subscribe to message and conversion events
4. **Analytics**: Dashboard showing submission trends, response times
5. **API rate limit per endpoint**: Different limits for contact vs admin
6. **Scheduled tasks**: Use NATS scheduler for daily summary emails
7. **Encryption at rest**: Full-disk encryption on VPS or encrypted CouchDB
8. **Message versioning**: Track all edits to admin-modified messages
