# Hardening Checklist

Items marked ✅ are verified completed. Items marked 🔲 require manual action.
Items marked ⚠️ are known risks with documented mitigations or upgrade paths.

## Secrets and Configuration

- ✅ No secrets committed to git — `.gitignore` excludes `.env` and all variants
- ✅ `.env.example` contains only placeholder values with generation instructions
- 🔲 `ADMIN_TOKEN` generated with `openssl rand -hex 32` in production
- 🔲 `COUCHDB_PASSWORD` is a unique, strong, non-dictionary value in production
- 🔲 `CORS_ORIGINS` set to exact production domain only
- 🔲 `LOG_LEVEL` set to `info` (not `debug`) in production

## Network and Infrastructure

- ✅ Only Caddy binds to host ports (80, 443)
- ✅ CouchDB and NATS have no host-bound ports — unreachable from the Internet
- ✅ Docker networks: `proxy` (Caddy↔API) and `backend` (all internal services) are separated
- 🔲 Firewall: only ports 22, 80, 443 open on the droplet/host
- 🔲 SSH: key-only authentication, root login disabled
- 🔲 Automatic OS security updates enabled
- 🔲 Confirm CouchDB port 5984 not accessible from outside Docker (`curl http://HOST:5984` should fail)
- 🔲 Confirm NATS port 4222 not accessible from outside Docker

## TLS / HTTPS

- ✅ Caddy manages TLS via Let's Encrypt automatically
- ✅ HTTP → HTTPS redirect is Caddy's default behaviour
- ✅ HSTS header set: `max-age=63072000; includeSubDomains; preload` (2 years)
- 🔲 After HSTS is stable in production, consider submitting to the HSTS preload list

## HTTP Security Headers (Caddy)

- ✅ `X-Content-Type-Options: nosniff`
- ✅ `X-Frame-Options: DENY`
- ✅ `Strict-Transport-Security` with 2-year max-age and preload
- ✅ `Referrer-Policy: strict-origin-when-cross-origin`
- ✅ `Permissions-Policy` restricting geolocation, microphone, camera, payment, usb
- ✅ `Content-Security-Policy` for admin SPA
- ✅ `Server` and `X-Powered-By` headers removed
- ✅ Deprecated `X-XSS-Protection` removed (CSP provides better protection)

## API Hardening

- ✅ CORS locked to `CORS_ORIGINS` (default: `https://roitsystems.ca`)
- ✅ Rate limiting: 10 requests / 15 minutes per IP on `POST /api/contact`
- ✅ Rate limiting: 30 requests / 15 minutes per IP on admin API endpoints
- ✅ Input validation: all fields validated and length-capped via Zod
- ✅ Honeypot field (`hp`) catches naive bots without CAPTCHA
- ✅ PII redacted from structured logs (email, name fields)
- ✅ Admin token comparison uses constant-time HMAC equality (timing-safe)
- ✅ Admin endpoints return 503 when `ADMIN_TOKEN` is not configured
- ✅ CouchDB error internals (paths, response bodies) not exposed to API callers
- ✅ CouchDB and webhook fetches have 10-second timeouts

## Container and Runtime

- ✅ Both `api` and `worker` Dockerfiles use `node:20-alpine` (minimal base image)
- ✅ Both images run as `USER node` (non-root)
- ✅ `NODE_ENV=production` set in both images
- ✅ Dev dependencies excluded from production images (`--omit=dev`)
- ✅ `npm ci` used in Dockerfiles for deterministic, lockfile-respecting installs
- ✅ Healthcheck defined in both `api` Dockerfile and `docker-compose.yml`
- ✅ `docker-compose.yml` uses `depends_on: condition: service_healthy` for startup ordering
- ✅ Graceful shutdown on both SIGTERM and SIGINT in api and worker

## Dependencies

- ✅ `npm ci` enforces lockfile integrity in Docker builds
- ✅ `audit=true` in `.npmrc` for all packages
- ✅ `npm run audit` script available in all packages
- ⚠️ **fastify <=4.x has known CVEs** (GHSA-mrq3-vjjr-p77c, GHSA-jx2c-rxcm-jvmq, GHSA-444r-cwp2-x5xf).
  Fix requires upgrading to fastify v5 (breaking change). See SECURITY_HARDENING_NOTES.md.
- ⚠️ **uuid <14.0.0** has a moderate CVE (GHSA-w5hq-g745-h8pq, buffer bounds check in v3/v5/v6).
  The API uses `uuidv4()` without a buffer argument so is not directly affected.
  Fix requires upgrading to uuid@14 (breaking change). See SECURITY_HARDENING_NOTES.md.

## NATS

- ✅ No public exposure — internal network only
- ✅ JetStream with file-backed storage and 30-day retention
- ✅ Durable consumer with explicit acks and max 5 redeliveries
- ✅ 5-second NAK backoff on processing failure
- 🔲 If attack surface grows (multi-tenant, external clients), add NATS `authorization {}` block

## CouchDB

- ✅ Not publicly reachable — no host-bound port
- ✅ API authenticates over Basic Auth on the backend Docker network
- 🔲 Backup schedule in place (see docs/operations.md)
- 🔲 CouchDB admin UI (`/_utils`) confirmed inaccessible from outside Docker
