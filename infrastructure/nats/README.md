# NATS authentication and authorization

`nats.conf` gives every client its own user and a permission set scoped to the
subjects it actually uses. Reaching the port is no longer sufficient to publish
or subscribe.

## Users

| User | Client | May publish | May subscribe |
| --- | --- | --- | --- |
| `aw-backend` | anchor-weather API / worker / scheduler | `anchor.weather.user.comms`, `anchor-weather-control.command` | `anchor-weather-control.status` |
| `aw-llm` | anchor-weather llm-service | `anchor.weather.user.comms` | — |
| `aw-control` | anchor-weather container-control daemon (on-host) | `anchor-weather-control.status` | `anchor-weather-control.command` |
| `aw-notify` | anchor-weather-notifications | — | `anchor.weather.user.comms` |
| `contact-api` | contact-inbox API | `contact.messages.*` | — |
| `contact-worker` | contact-inbox worker | `image.ready` | `contact.messages.*` |
| `contact-notify` | contact-inbox notification | — | `contact.messages.new` |
| `image-api` | image-converter API | `image.convert` | `image.ready` |
| `image-magick` | imagemagick worker | `image.convert`, `image.ready` | `image.convert`, `image.ready` |

JetStream users additionally get `$JS.API.*` endpoints **scoped to the streams
they own**, so no client can create, modify or drain another service's stream.

## Credentials

`nats.conf` contains no secrets. Each password is an environment reference
resolved by the server at startup, supplied from `infrastructure/.env`.

How a client presents that password **depends on its library**:

| Library | Used by | Form |
| --- | --- | --- |
| nats-py | anchor-weather backend/worker/scheduler, llm-service, container-control | credentials in the URL: `NATS_URL=nats://<user>:<pass>@nats:4222` |
| nats.js | contact-inbox (×3), image-converter (×2), anchor-weather-notifications | **separate options**: `NATS_URL=nats://nats:4222` plus `NATS_USER` / `NATS_PASS` |

nats.js cannot parse credentials embedded in the servers URL — it throws
`TypeError: Invalid URL` on `nats://user:pass@host:4222` — so those services
take `NATS_USER` and `NATS_PASS` as their own environment variables and pass
them to `connect()` as options. With `NATS_USER` unset they connect
unauthenticated, which is what the `no_auth_user` shim expects mid-rollout.

Generate:

```bash
for k in AW_BACKEND AW_LLM AW_CONTROL AW_NOTIFY CONTACT_API \
         CONTACT_WORKER CONTACT_NOTIFY IMAGE_API IMAGE_MAGICK LEGACY_OPEN; do
    echo "NATS_PASS_$k=$(openssl rand -hex 24)"
done
```

Values are needed in `infrastructure/.env` (all of them, for the server) and in
each client project's `.env` (its own one only). Rotating a credential is an
`.env` edit plus a reload — it never touches this repo.

If a referenced variable is unset the server **refuses to start**, so a missing
credential fails loudly instead of quietly running without authentication.

## Rollout (completed 2026-09-16)

Every client now authenticates. The `no_auth_user` shim that allowed
credential-less connections during the migration has been removed, so a
process that reaches the port without credentials is refused.

The cutover was done one service at a time behind that shim, which is worth
knowing if this is ever repeated: while `no_auth_user` is set, clients
connecting *without* credentials are accepted and mapped to a named user, so
services move across individually instead of in lockstep. Two things caught us
out and are worth writing down:

- **`no_auth_user` only covers connections presenting NO credentials.** A
  client that sends a username with a wrong or empty password is rejected
  outright. A service whose `NATS_URL` interpolated to an empty password
  therefore failed as soon as auth was switched on, rather than falling back.
- **Passwords are parsed as config tokens**, not opaque strings. Generate
  letter-leading values (`n$(openssl rand -hex 24)`); an all-digit value makes
  the server fail to start.

## Verifying

Check the config parses before deploying — a syntax error here stops the bus:

```bash
docker run --rm --network none \
  -v "$PWD/nats/nats.conf:/tmp/nats.conf:ro" \
  --env-file .env \
  nats:2 -t -c /tmp/nats.conf
```

The permission model was exercised end to end against a throwaway server with
both client libraries (nats-py and nats.js): stream creation, JetStream publish,
durable pull consumers, ack, core pub/sub, and negative cases confirming a
client cannot publish to another service's subjects.

## Adding a client

1. Add a permission block and a `users` entry in `nats.conf`.
2. Add `NATS_PASS_<NAME>` to `infrastructure/.env` and to the nats service's
   `environment:` in `infrastructure/docker-compose.yml`.
3. Give the client `NATS_URL=nats://<user>:<password>@nats:4222`.

Grant the narrowest subject set that works. If a JetStream client fails with
`permissions violation for publish to $JS.API...`, the error names the missing
endpoint — add that one rather than widening to `$JS.API.>`.
