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
                     Public Internet
                           │ HTTPS
                           ▼
                 ┌───────────────────┐
                 │  Caddy            │  TLS, security headers, routing
                 │  (infrastructure) │
                 └───┬───────────┬───┘
   /api/contact      │           │  /corporate-network/image-converter/*
   /api/admin/*      │           │
   /auth/*           │           │
   /corporate-network/contact/*  │
   /health           │           │
                     ▼           ▼
   ┌──────────────────────┐   ┌──────────────────────────┐
   │ contact-inbox-api    │   │ image-converter-api      │
   │ contact intake,      │   │ image jobs, the          │
   │ admin API and page,  │   │ converter page,          │
   │ Google sign-in       │   │ image.ready listener     │
   └──────┬───────────────┘   └──────┬───────────────────┘
          │                          │
          ▼                          ▼
   ┌───────────────────── corporate-backend network ─────────────────────┐
   │  CouchDB (messages, image jobs)        NATS JetStream               │
   │                                                                     │
   │  contact-inbox-worker        contact.messages.new → status, webhook │
   │  contact-inbox-notification  contact.messages.new → Claude, Resend  │
   │  imagemagick-service         image.convert → image.ready            │
   └─────────────────────────────────────────────────────────────────────┘
```

Each box is a container. Only Caddy publishes ports; everything else is on
internal Docker networks. The three Compose projects are `infrastructure/`
(Caddy, NATS, CouchDB), `corporate-network/contact-inbox/` and
`corporate-network/image-converter/`.

---

## Component Responsibilities

### **Caddy** (Reverse Proxy & TLS)
- Terminates HTTPS/TLS and provisions Let's Encrypt certificates automatically
- Sets the security headers, and a Content-Security-Policy for the admin pages
- Routes each path to the API that serves it
- **Stateless** apart from its certificates (`caddy-data` volume)

### **contact-inbox-api** (Fastify, TypeScript)
- Accepts contact form submissions via `POST /api/contact`
- Validates input (Zod; honeypot field must be empty) and rate-limits per client
- Stores contact messages in CouchDB and publishes `contact.messages.new` to NATS
- Serves the admin API (`/api/admin/*`) and the message viewer (`/corporate-network/contact/admin`)
- Runs the Google sign-in (`/auth/*`) and issues the admin session cookie
- **Stateless** (except for in-flight requests)

### **image-converter-api** (Fastify, TypeScript)
- Accepts image jobs (`POST /corporate-network/image-converter/api/image-jobs`) and answers status polls
- Serves the converter page (`/corporate-network/image-converter/convert`)
- Accepts the same admin session cookie as contact-inbox-api
- Stores job documents in CouchDB, publishes `image.convert`, and records results from `image.ready`
- **Stateless** (except for in-flight requests)

### **CouchDB** (Document Store)
- Durably stores contact messages and image-job documents
- Supports revision-based concurrency control (`_rev`)
- Databases are created on first API startup
- **Stateful**: back it up (see [docs/operations.md](docs/operations.md))

### **NATS JetStream** (Event Streaming)
- Carries contact events (`CONTACT_MESSAGES` stream) and image-job messages
- Durable consumers with explicit acknowledgement for contact events
- Each client connects with its own user and subject permissions
- **Stateful**: retains events in file storage (`nats-data` volume)

### **contact-inbox-worker** (TypeScript)
- Consumes `contact.messages.new` from the `CONTACT_MESSAGES` stream
- Updates the message's status in CouchDB
- Calls the optional `NOTIFICATION_WEBHOOK_URL` relay
- **Stateless**

### **contact-inbox-notification** (Node.js)
- Subscribes to `contact.messages.new`
- Asks the Claude API for an analysis of the enquiry
- Sends the email summary through Resend
- **Stateless**

### **imagemagick-service** (Node.js)
- Subscribes to `image.convert`
- Runs the ImageMagick CLI with the requested settings
- Publishes `image.ready` with the base64 result in the requested format, or an error
- **Stateless**: processes one job at a time

---

## Data Flow

### Contact Message Submission

```
1. Browser submits the contact form to POST /api/contact on the API domain
2. Fastify validates input (Zod schema)
3. Fastify rate-limits by IP
4. Fastify generates unique _id (UUID)
5. Fastify stores doc in CouchDB: { _id, name, email, message, status: 'submitted', ... }
6. Fastify publishes event to NATS: { type: 'contact.new', message_id, timestamp }
7. Fastify returns 201 with message_id
8. Browser redirects to confirmation page
9. contact-inbox-worker consumes 'contact.messages.new' from the CONTACT_MESSAGES stream
10. The worker sets the message's status in CouchDB and calls the optional webhook relay
11. contact-inbox-notification receives the same event
12. It asks the Claude API for an analysis of the enquiry
13. It emails the summary through Resend to NOTIFICATION_EMAIL
```

### Image Conversion Job

```
1. Admin UI submits job: POST /corporate-network/image-converter/api/image-jobs, JSON with filename, base64 data, format_in, format_out and settings
2. The image-converter API checks the admin session cookie
3. Fastify generates transaction_id (UUID)
4. Fastify stores job doc in CouchDB: { _id: transaction_id, status: 'queued', params, filename }
5. Fastify publishes 'image.convert' to NATS: { transaction_id, data, params }
6. Fastify returns 202 with transaction_id
7. ImageMagick worker receives 'image.convert' event
8. Worker takes the base64 image from the message
9. Worker calls: convert input.png -format webp -quality 85 output.webp
10. Worker encodes result as base64
11. Worker publishes 'image.ready': { transaction_id, data: base64 }
12. The image-converter API's image.ready listener updates CouchDB: { _id: transaction_id, status: 'done', data: base64, ... }
13. Admin UI polls GET /corporate-network/image-converter/api/image-jobs/:transaction_id
14. Frontend detects status === 'done', displays preview, shows download button
15. User clicks download → browser decodes base64 and saves file
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
- **Google sign-in**, limited to the accounts in `ADMIN_EMAILS`
- An 8-hour `session` cookie signed with `SESSION_SECRET` (HMAC-SHA256); no JWT, no API tokens
- Checked by the contact-inbox admin API and the image-converter API

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
- Consumers: contact-inbox-worker (durable); contact-inbox-notification also subscribes

**IMAGE_JOBS**
- Subjects: `image.convert`, `image.ready`
- Payload (convert): `{ transaction_id: UUID, type: 'image.convert', params: {...} }`
- Payload (ready): `{ transaction_id: UUID, data: base64 }`
- Retention: 7 days
- Consumers: imagemagick-service (`image.convert`), image-converter-api (`image.ready`, for status updates)

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
  "budget": "15k–35k",
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
    "format_in": "png",
    "format_out": "webp",
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
- Only Caddy publishes ports (80, 443)
- The other services are on internal Docker networks
- NATS clients each connect with their own user and subject permissions

### Authentication
- **Admin API and pages**: Google sign-in, then a signed HttpOnly session cookie
- **Contact form**: No auth required; rate-limiting provides DOS protection

### Data Protection
- **PII in logs**: Redacted by Fastify logger (`email`, `name` fields)
- **HTTPS/TLS**: Automatic renewal via Let's Encrypt

### Input Validation
- **Contact form**: Zod schema validates types and lengths
- **Honeypot**: Empty field submission triggers validation error
- **Image jobs**: JSON body up to 50 MB, base64 image, `format_in`/`format_out` from fixed lists
- **Parameters**: Numeric ranges validated (quality 1–100, density 1–600, size up to 16384 px)

---

## Deployment Considerations

### Single Server
- All services on one host keeps networking and secrets management simple
- Scales vertically (a larger host) as needed

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
# Health check (Caddy's local certificate, hence -k; see INSTALL.md)
curl -k https://localhost/health

# Submit contact message
curl -k -X POST https://localhost/api/contact \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","message":"Test"}'

# Admin endpoints need a browser session: open
# https://localhost/corporate-network/contact/admin and sign in with Google
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
5. **Scheduled tasks**: Use NATS scheduler for daily summary emails
6. **Message versioning**: Track all edits to admin-modified messages
