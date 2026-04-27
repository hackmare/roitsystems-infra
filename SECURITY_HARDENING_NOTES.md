# Security Hardening Notes — roitsystems-infra

## Assessment Summary

Well-structured backend: CORS, Zod validation, honeypot, PII log redaction, and
network isolation were already in place. The gaps were in admin auth hardening,
error information disclosure, missing timeouts, incomplete signal handling,
and missing HTTP response headers.

---

## Risks Found

| # | Risk | Severity | Status |
|---|------|----------|--------|
| 1 | Admin token compared with `!==` — vulnerable to timing attacks | Medium | Fixed |
| 2 | Admin API endpoints had no rate limiting — brute-force possible | Medium | Fixed |
| 3 | Admin endpoints returned 401 when `ADMIN_TOKEN` unconfigured — ambiguous | Low | Fixed (503) |
| 4 | CouchDB errors exposed method, path, and response body in thrown Error messages | Medium | Fixed |
| 5 | All `fetch()` calls (CouchDB, webhook) had no timeout | Medium | Fixed (10s) |
| 6 | Only SIGTERM handled in api and worker — SIGINT (Ctrl+C) not caught | Low | Fixed |
| 7 | Caddyfile: no HSTS header | High | Fixed |
| 8 | Caddyfile: no Permissions-Policy header | Low | Fixed |
| 9 | Caddyfile: no Content-Security-Policy for admin page | Medium | Fixed |
| 10 | Caddyfile: deprecated `X-XSS-Protection` header present | Low | Fixed (removed) |
| 11 | Caddy route matcher `/admin*` matched paths like `/adminx` — too broad | Low | Fixed |
| 12 | `docker-compose.yml` used deprecated `version:` key | Low | Fixed (removed) |
| 13 | `LOG_LEVEL` not forwarded to api service in docker-compose | Low | Fixed |
| 14 | `npm install` used in Dockerfiles — not deterministic without lockfile | Medium | Fixed (npm ci) |
| 15 | No lockfiles for api or worker packages | Medium | Fixed (generated) |
| 16 | No `audit` script in api/worker package.json | Low | Fixed |
| 17 | No `.npmrc` for api/worker packages | Low | Fixed |
| 18 | Fastify v4 has 3 known CVEs (see below) | High | Documented — manual upgrade needed |
| 19 | uuid v9 has a moderate CVE (buffer bounds in v3/v5/v6) | Low | Documented (not directly exploitable here) |

---

## Changes Made

### `api/src/routes/admin.ts`
- Replaced `auth !== 'Bearer ${ADMIN_TOKEN}'` string comparison with
  `timingSafeEqual(hmac(provided), hmac(expected))` using a per-process HMAC key.
  HMAC wrapping ensures both buffers are always SHA-256 length, preventing
  length-based timing leaks.
- Returns 503 (not 401) when `ADMIN_TOKEN` is not configured, to distinguish
  "wrong token" from "admin not set up".
- Added per-route rate limiting: 30 requests / 15 minutes per IP on both
  admin endpoints, using the already-registered `@fastify/rate-limit` plugin's
  `config.rateLimit` route option (consistent with global: false setup in index.ts).

### `api/src/services/couchdb.ts` and `worker/src/services/couchdb.ts`
- Added 10-second `AbortController` timeout to all CouchDB `fetch()` calls.
- CouchDB error internals (method, path, response body) are now logged at
  `console.error` internally but the thrown `Error` message is sanitized to
  `Database error (${statusCode})` only.

### `worker/src/handlers/contact.ts`
- Added 10-second `AbortController` timeout to the notification webhook `fetch()`.

### `api/src/index.ts`
- Added `SIGINT` handler (alongside existing `SIGTERM`) for graceful shutdown.
  Both signals call the same `shutdown()` function.

### `worker/src/index.ts`
- Added `SIGINT` handler alongside existing `SIGTERM`.

### `caddy/Caddyfile`
- Added `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (2 years).
- Added `Permissions-Policy` restricting geolocation, microphone, camera, payment, usb.
- Added `Content-Security-Policy` for the admin SPA
  (`unsafe-inline` required for inline scripts/styles in the admin HTML page).
- Removed deprecated `X-XSS-Protection` header.
- Fixed route matcher: changed `/admin*` to `/admin /admin/*` to avoid matching
  paths like `/adminx` that have no legitimate handler.

### `docker-compose.yml`
- Removed deprecated `version: '3.9'` key (Compose v2 ignores it).
- Added `LOG_LEVEL=${LOG_LEVEL:-info}` to api service environment.

### `api/Dockerfile` and `worker/Dockerfile`
- Replaced `npm install` with `npm ci` in both build and runner stages.
  `npm ci` is deterministic, enforces lockfile integrity, and fails if
  `package.json` and `package-lock.json` are out of sync.
- Added `HEALTHCHECK` instruction to the api Dockerfile (mirrors docker-compose healthcheck,
  making it available without Compose).

### `api/package.json` and `worker/package.json`
- Added `audit` and `test` scripts.

### `api/.npmrc` and `worker/.npmrc` (new)
- `audit=true` and `fund=false`.

### `SECURITY.md` (new)
- Responsible disclosure contact and scope.

### `HARDENING_CHECKLIST.md` (new)
- Comprehensive checklist of completed and pending hardening items.

---

## npm audit Results

### api package
```
2 vulnerabilities (1 moderate, 1 high)
```

**High — fastify <=5.8.2 (3 CVEs):**
- GHSA-mrq3-vjjr-p77c: DoS via unbounded memory in `sendWebStream`
  → This API does not use `sendWebStream`. Not directly exploitable.
- GHSA-jx2c-rxcm-jvmq: Content-Type tab character allows body validation bypass
  → Could allow bypassing Zod validation on the contact endpoint. Relevant.
- GHSA-444r-cwp2-x5xf: `request.protocol` / `request.host` spoofable via
  `X-Forwarded-*` from untrusted connections
  → `trustProxy: true` is set. Relevant if protocol/host is used for routing decisions.
  Currently only used for rate limiting IP extraction.

**Fix:** `npm audit fix --force` upgrades fastify to v5.x — a **breaking major version**.
Fastify v5 changes plugin registration, logger API, and TypeScript types.
**Manual action required:** Upgrade and test on a branch before merging.

**Moderate — uuid <14.0.0 (GHSA-w5hq-g745-h8pq):**
Buffer bounds check missing in v3/v5/v6 when a `buf` argument is provided.
This API uses `uuidv4()` without a `buf` argument. Not directly exploitable here.
Fix: `npm audit fix --force` installs uuid@14 (breaking change — different export API).

### worker package
```
0 vulnerabilities
```

---

## Remaining Recommended Actions

### Priority 1 — Upgrade Fastify (Manual, Breaking)

```bash
cd api
# Review Fastify v5 migration guide: https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/
npm install fastify@^5 @fastify/cors@^10 @fastify/rate-limit@^10
npm run build
# Fix TypeScript errors introduced by v5 API changes
# Test all endpoints
```

Key Fastify v5 changes to address:
- Plugin registration API changes
- Logger `redact` configuration may change
- `request.params` type assertion approach may change

### Priority 2 — Replace Tailwind CDN Play Script in roitsystems.ca (Manual)

The Tailwind CDN URL (`https://cdn.tailwindcss.com`) loads a development build script
that compiles CSS at runtime. It is not recommended for production use.

Recommended fix: run `npx tailwindcss init` and set up a proper build step so CSS
is compiled ahead of time. This removes the CDN dependency, improves performance,
and allows a tighter CSP.

### Priority 3 — NATS Authentication (If Exposure Grows)

NATS has no authentication configured. This is acceptable while it is internal-only.
If the network perimeter ever changes (multi-tenant hosting, public NATS port),
add an `authorization {}` block to `nats/nats.conf`.

### Priority 4 — Admin UI Hardening (Consider)

The admin token is stored in `sessionStorage`. This is acceptable but:
- XSS in the admin page would expose the token.
- The CSP allows `'unsafe-inline'` for scripts (required for the inline script block).

Long-term: extract inline scripts to a separate JS file and tighten CSP.
Or replace with a proper session-based auth flow.

### Priority 5 — HSTS Preload (After Production Stability)

The HSTS header is set with the `preload` directive.
Once the production setup is stable and the 2-year max-age has been confirmed,
submit `api.roitsystems.ca` to https://hstspreload.org.
