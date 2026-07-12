# Security

## Threat Model

This stack accepts public contact form submissions and stores them privately. The main threats are:

- Spam / bot submissions
- Personal data exfiltration
- Unauthorised access to stored messages
- Secrets exposure in code or logs

## Controls

### Network

- Only Caddy binds to host ports (80, 443).
- CouchDB has **no host-bound ports** — unreachable from the Internet.
- NATS is bound to `127.0.0.1:4222` only (for anchor-weather's
  `container-control` daemon, which runs on the host and can't join the
  `backend` Docker network) — still unreachable from the Internet or any
  other host, just no longer Docker-network-only.
- The `proxy` Docker network connects Caddy↔API only.
- The `backend` Docker network connects all internal services.

### HTTPS / TLS

- Caddy provisions and auto-renews certificates via Let's Encrypt (ACME HTTP-01).
- HTTP port 80 redirects to HTTPS automatically (Caddy default behaviour).
- Security headers set by Caddy: `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`.

### API

- **CORS**: locked to `CORS_ORIGINS` (default: `https://roitsystems.ca`).
- **Rate limiting**: 10 requests per 15 minutes per IP on `POST /api/contact`.
- **Input validation**: all fields validated and length-capped via Zod.
- **Honeypot**: a hidden `hp` field catches naive bots without a CAPTCHA UX.
- **Sanitisation**: no template rendering with user data; values stored as-is and escaped on display.
- **Logging**: email and name fields are redacted from structured logs.

### Admin Access

- `GET /api/admin/messages` and `GET /api/admin/messages/:id` require `Authorization: Bearer <ADMIN_TOKEN>`.
- `ADMIN_TOKEN` is a 256-bit random hex string (generated with `openssl rand -hex 32`).
- The token is never logged or returned in any response.
- The admin UI (`/admin`) is excluded from search engine indexing via `<meta name="robots" content="noindex, nofollow">`.

### Secrets

- No secrets committed to git — `.gitignore` excludes `.env` and all variants.
- `.env.example` contains only placeholder values.
- In production, secrets are injected as environment variables (DigitalOcean App Platform env vars or Droplet `/etc/environment`).

### CouchDB

- Admin credentials set via `COUCHDB_USER` / `COUCHDB_PASSWORD` environment variables.
- CouchDB is not publicly reachable — no extra auth layer needed at the network level.
- The API authenticates to CouchDB over the `backend` Docker network using Basic Auth.

### NATS

- No authentication configured (loopback + internal Docker network only, no
  public exposure).
- If the attack surface grows, add NATS `authorization {}` block to `nats.conf`.

## Hardening Checklist (Pre-Production)

- [ ] `ADMIN_TOKEN` generated with `openssl rand -hex 32`
- [ ] `COUCHDB_PASSWORD` is unique, strong, and not a dictionary word
- [ ] `CORS_ORIGINS` set to exact production domain only
- [ ] Firewall: only ports 22, 80, 443 open on the droplet
- [ ] SSH: key-only authentication, root login disabled
- [ ] Automatic OS security updates enabled
- [ ] CouchDB port 5984 confirmed not accessible from host (`curl localhost:5984` should fail from outside Docker)
- [ ] NATS port 4222 confirmed bound to `127.0.0.1` only (`curl` from another machine should fail; `curl 127.0.0.1:4222` on the droplet itself should succeed)
- [ ] `LOG_LEVEL` set to `info` (not `debug`) in production
- [ ] Backup schedule in place (see operations.md)
