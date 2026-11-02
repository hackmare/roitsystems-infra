# Hardening Checklist

Things to confirm before a deployment of this stack goes into production, and
again after any change to the host, the Caddyfile or the compose files.

## Secrets and Configuration

- [ ] No secrets are committed to git; `.gitignore` excludes `.env` and its variants
- [ ] `.env.example` holds only placeholder values
- [ ] Each project's `.env` (`infrastructure/`, `corporate-network/contact-inbox/`, `corporate-network/image-converter/`) is readable only by the deploy user
- [ ] `SESSION_SECRET` is generated with `openssl rand -hex 32`, and the two APIs share it
- [ ] `ADMIN_EMAILS` lists only the intended admins
- [ ] `COUCHDB_PASSWORD` is unique and strong
- [ ] `CORS_ORIGINS` names the exact production site only
- [ ] `LOG_LEVEL` is `info`, not `debug`

## Network and Host

- [ ] Only Caddy publishes ports to the host (80 and 443)
- [ ] Internal services (CouchDB, NATS, the APIs and workers) aren't reachable from outside the host
- [ ] The firewall allows only what's needed
- [ ] SSH accepts keys only, and root login is disabled
- [ ] Automatic OS security updates are on

## TLS / HTTPS

- [ ] Caddy obtains and renews certificates automatically
- [ ] HTTP redirects to HTTPS
- [ ] HSTS is sent

## HTTP Security Headers (Caddy)

- [ ] `X-Content-Type-Options: nosniff`
- [ ] `X-Frame-Options: DENY`
- [ ] `Strict-Transport-Security`
- [ ] `Referrer-Policy: strict-origin-when-cross-origin`
- [ ] `Permissions-Policy` restricting device features
- [ ] `Content-Security-Policy` on the admin pages
- [ ] `Server` and `X-Powered-By` removed

## API

- [ ] Admin pages and APIs need Google sign-in, limited to `ADMIN_EMAILS`
- [ ] The APIs refuse to start without a 32+ character `SESSION_SECRET` and at least one admin
- [ ] Contact submissions and admin endpoints are rate-limited per client
- [ ] Input is validated and length-capped
- [ ] Personal data (names, email addresses) and the `Authorization` header are redacted from logs
- [ ] Database errors reach callers without internal detail

## Containers

- [ ] Images are built from pinned Node LTS base images; Dependabot proposes updates
- [ ] Containers run as a non-root user
- [ ] Production images exclude dev dependencies and install with `npm ci`
- [ ] Services shut down cleanly on SIGTERM and SIGINT

## Dependencies

- [ ] `npm ci` installs from the lockfile in every image
- [ ] `npm audit` is clean, or each finding is understood
- [ ] Dependabot pull requests are reviewed and merged

## NATS

- [ ] NATS isn't published outside the host
- [ ] Each client connects with its own user, limited to the subjects it needs

## CouchDB

- [ ] CouchDB isn't published outside the host, including its admin UI (`/_utils`)
- [ ] Backups run on a schedule and a restore has been tested (see [docs/operations.md](docs/operations.md))
