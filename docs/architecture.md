# Architecture

## Overview

```
Internet
   │  HTTPS 443
   ▼
┌──────────┐   proxy network
│  Caddy   │ ──────────────► API :3000
│ (TLS)    │
└──────────┘

backend network only (not reachable from Internet)
┌─────────────────────────────────────────────────┐
│                                                 │
│  API ──► CouchDB :5984  (contact_messages)      │
│   │                     (bot_state)             │
│   └──► NATS :4222  JetStream: CONTACT_MESSAGES  │
│                                                 │
│  Worker ◄── NATS (consumer: worker)             │
│    └──► CouchDB (status updates)               │
│    └──► Webhook (optional notifications)        │
│                                                 │
└─────────────────────────────────────────────────┘
```

## Network Isolation

| Network   | Members              | Internet Access |
|-----------|----------------------|-----------------|
| `proxy`   | Caddy, API           | Yes (via host)  |
| `backend` | API, Worker, CouchDB, NATS | Yes (outbound only, no bound ports) |

CouchDB has **no ports bound to the host** — only reachable by services on
the `backend` Docker network. NATS is additionally bound to `127.0.0.1:4222`
on the host (for anchor-weather's `container-control` daemon, a separate
app's on-host process that can't join this Docker network) — still
unreachable from the Internet, just no longer Docker-network-only. See
`infrastructure/docker-compose.yml` and `infrastructure/nats/nats.conf`.

## Data Flow — Contact Form Submission

1. Browser POSTs to `https://api.roitsystems.ca/api/contact`
2. Caddy terminates TLS, forwards to `api:3000`
3. API validates + rate-limits the request
4. API writes document to CouchDB `contact_messages` (status: `received`)
5. API publishes `contact.messages.new` event to NATS JetStream
6. API returns `{ success: true }` to browser
7. Worker receives JetStream event
8. Worker marks document `processing`, fires optional webhook, marks `processed`

## Services

### Caddy
- Automatic HTTPS via Let's Encrypt
- Routes `/api/*`, `/admin*`, `/health` to the API
- Blocks all other paths with 404

### CouchDB 3.3
- `contact_messages` — one document per form submission
- `bot_state` — reserved for future worker state persistence
- Persistent volume at `/opt/couchdb/data`

### NATS JetStream
- Stream `CONTACT_MESSAGES`, subject `contact.messages.*`
- File-backed storage, 30-day retention
- Pull consumer `worker` with explicit acks, max 5 redeliveries

### API (Node.js / TypeScript / Fastify)
- `POST /api/contact` — public, rate-limited (10 req / 15 min per IP)
- `GET /api/admin/messages` — private, Bearer token required
- `GET /api/admin/messages/:id` — private, Bearer token required
- `GET /admin` — admin SPA (authentication handled client-side)
- `GET /health` — liveness probe

### Worker (Node.js / TypeScript)
- Durable JetStream pull consumer
- Updates message status in CouchDB
- Fires optional webhook for future Signal/Telegram/email integration
- Retries up to 5× with 5-second backoff on failure
