# Google OAuth 2.0 Setup

This document describes the Google OAuth 2.0 authentication system for admin UIs in the roitsystems-infra project.

## Overview

All admin interfaces now use Google OAuth 2.0 for authentication instead of bearer tokens or HTTP Basic auth:

- **Contact Inbox Admin**: `https://pubapi.roitsystems.ca/contact/admin`
- **Image Converter Admin**: `https://pubapi.roitsystems.ca/corporate-network/image-converter/convert`
- **Corporate Network Dashboard**: `https://pubapi.roitsystems.ca/corporate-network/`

Users authenticate via their Google account. Access is restricted to an allowlist of email addresses defined in `ADMIN_EMAILS`.

## Architecture

```
Browser → Caddy → contact-inbox-api:3000
               → image-converter-api:3000

GET /auth/login?next=<path>
  ↓ (Google OAuth redirect)
GET /auth/callback?code=<code>&state=<state>
  ↓ (verify email against allowlist)
Set signed httpOnly session cookie
  ↓
Redirect to protected page
```

### Session Cookie

- **Payload**: `{email: string, exp: number}` (expires 8 hours from issue)
- **Format**: `<base64url(payload)>.<hmac-sha256(payload, SESSION_SECRET)>`
- **Flags**: `httpOnly: true`, `secure: true`, `sameSite: lax`, `path: /`
- **Domain**: `api.roitsystems.ca` (visible to both contact-inbox and image-converter APIs)

The cookie is verified independently by each API using the same `SESSION_SECRET`.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Yes | OAuth 2.0 Client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth 2.0 Client Secret from Google Cloud Console |
| `ADMIN_EMAILS` | Yes | Comma-separated list of allowed Google account emails (e.g., `user1@example.com,user2@example.com`) |
| `SESSION_SECRET` | Yes | 32-byte hex string for signing session cookies (generate with `openssl rand -hex 32`) |
| `API_DOMAIN` | Yes | Public API domain (e.g., `api.roitsystems.ca` for production, `localhost:3000` for local dev) |

## Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create or select a project (e.g., `roitsystems-admin`)
3. Enable the "Google+ API"
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Select **Web application**
6. Add **Authorized redirect URIs**:
   - Production: `https://<API_DOMAIN>/auth/callback`
   - Local development: `http://localhost:3000/auth/callback`
7. Copy the Client ID and Client Secret

## Local Development

### 1. Generate Secrets

```bash
# Generate SESSION_SECRET
openssl rand -hex 32
# Example output: d91aa4bc7ce970421b1867e0722c8e5e644312c47c32ea8194162ecef6aaa1d0
```

### 2. Create `.env` File

```bash
cp .env.example .env
```

Edit `.env` and add:
```
GOOGLE_CLIENT_ID=<from Google Cloud Console>
GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
ADMIN_EMAILS=<your-email@gmail.com,colleague@gmail.com>
SESSION_SECRET=<output from openssl command>
API_DOMAIN=localhost:3000
```

### 3. Start Services

```bash
# In corporate-network/contact-inbox
docker-compose up

# In corporate-network/image-converter
docker-compose up
```

### 4. Test Login

1. Visit `http://localhost:3000/corporate-network/`
2. You'll be redirected to `/auth/login`
3. Click "Sign in with Google"
4. Authenticate with your Google account
5. If your email is in `ADMIN_EMAILS`, you'll see the dashboard
6. Otherwise, you'll get a 403 Forbidden error

## Production Deployment

### 1. Prepare Environment Variables

Generate a new `SESSION_SECRET` and ensure Google Cloud redirect URI is configured:

```bash
openssl rand -hex 32
```

### 2. Update `.env` on Droplet

SSH to the production droplet and update `/root/roitsystems-infra/.env`:

```bash
ssh -i ~/.ssh/roitsystems root@137.184.160.162
vi .env
```

Update these values:
```
GOOGLE_CLIENT_ID=<production client ID>
GOOGLE_CLIENT_SECRET=<production client secret>
ADMIN_EMAILS=m.oger@roitsystems.ca,morgane@morganeoger.ca
SESSION_SECRET=<production session secret>
API_DOMAIN=pubapi.roitsystems.ca
```

### 3. Deploy

```bash
cd /root/roitsystems-infra/corporate-network/contact-inbox
docker-compose down
docker-compose up -d --build

cd /root/roitsystems-infra/corporate-network/image-converter
docker-compose down
docker-compose up -d --build
```

Alternatively, use the deployment script with environment variables sourced:

```bash
set -a; source .env; set +a
./deploy.sh
```

## User Flow

### Login

1. User visits a protected page (e.g., `/contact/admin`)
2. No valid session cookie → redirected to `/auth/login`
3. User clicks "Sign in with Google"
4. Server generates a CSRF `state` nonce and stores it in a short-lived cookie
5. User is redirected to Google's OAuth consent screen
6. After consent, Google redirects back to `/auth/callback?code=<code>&state=<state>`
7. Server verifies the state nonce, exchanges the code for an ID token
8. Server extracts the email from the ID token and checks against `ADMIN_EMAILS`
9. If allowed, a signed session cookie is issued
10. User is redirected to the requested page

### Logout

1. User clicks "Sign out"
2. Session cookie is cleared
3. User is redirected to `/auth/login`

## Security

- **CSRF Protection**: `state` nonce stored in httpOnly cookie, validated before issuing session
- **Session Signing**: HMAC-SHA256 with `SESSION_SECRET` prevents tampering
- **HTTPOnly Cookies**: Session cookie is not accessible to JavaScript (XSS protection)
- **Secure Flag**: Cookies only sent over HTTPS in production
- **SameSite Lax**: Protects against cross-site request forgery while allowing OAuth redirect
- **Email Allowlist**: Only specific Google accounts can authenticate
- **Token Expiry**: Sessions expire after 8 hours; users must re-authenticate

## Troubleshooting

### "Error 400: redirect_uri_mismatch"

**Cause**: The callback URL in your Google Cloud credential doesn't match the deployment URL.

**Fix**: 
1. Go to Google Cloud Console → Credentials
2. Edit the OAuth 2.0 Client ID
3. Ensure "Authorized redirect URIs" includes `https://<API_DOMAIN>/auth/callback`

### "403 Forbidden"

**Cause**: Your Google account email is not in `ADMIN_EMAILS`.

**Fix**: Add your email to the `ADMIN_EMAILS` environment variable (comma-separated list).

### Session cookie not being set

**Cause**: The `SESSION_SECRET` or Google credentials might be incorrect, or the ID token verification failed.

**Fix**: Check the API logs for detailed error messages:
```bash
docker logs contact-inbox-api
```

### Users can't access the page after redeployment

**Cause**: Session secret was changed, invalidating all existing sessions.

**Fix**: Users need to clear their cookies or log in again.

## Files Modified

- `corporate-network/contact-inbox/api/src/routes/auth.ts` (new)
- `corporate-network/contact-inbox/api/src/routes/admin.ts` (updated)
- `corporate-network/contact-inbox/api/src/index.ts` (updated)
- `corporate-network/image-converter/api/src/auth.ts` (new)
- `corporate-network/image-converter/api/src/routes/image-jobs.ts` (updated)
- `infrastructure/caddy/Caddyfile` (HTTP Basic auth removed)
- `corporate-network/contact-inbox/docker-compose.yml` (updated env vars)
- `corporate-network/image-converter/docker-compose.yml` (updated env vars)
- `.env.example` (updated env vars)

## Migration from Bearer Token Auth

If migrating an existing deployment from bearer token auth:

1. Remove `ADMIN_TOKEN` from `.env`
2. Add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_EMAILS`, `SESSION_SECRET`
3. Update `API_DOMAIN` to use the public API hostname
4. Redeploy all services
5. Users no longer need to paste a bearer token; they authenticate via Google

## References

- [Google OAuth 2.0 Documentation](https://developers.google.com/identity/protocols/oauth2)
- [google-auth-library-nodejs](https://github.com/googleapis/google-auth-library-nodejs)
- [Fastify Cookie Plugin](https://github.com/fastify/cookie)
