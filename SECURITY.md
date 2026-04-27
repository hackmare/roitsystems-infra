# Security Policy

## Supported Versions

| Component | Status   |
|-----------|----------|
| roitsystems-infra (current main branch) | Supported |

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly:

**Contact:** security@roitsystems.ca (or info@roitsystems.ca if security alias not yet configured)

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Any proof-of-concept code or screenshots

We aim to acknowledge receipt within 2 business days and provide a fix timeline within 10 business days for critical issues.

Please do **not** open a public GitHub issue for security vulnerabilities.

## Scope

This repository covers the API server, worker, message broker (NATS), datastore (CouchDB),
and reverse proxy (Caddy) that form the backend infrastructure for roitsystems.ca.
