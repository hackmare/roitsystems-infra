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
resolved by the server at startup, supplied from `infrastructure/.env`. The
same value goes in the client's own `NATS_URL`
(`nats://<user>:<password>@nats:4222`).

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

## Rolling this out without an outage

Every client shares one bus, so a single cutover would need every service
restarted in lockstep. `no_auth_user` avoids that: while it is set, a client
that connects *without* credentials is accepted and mapped to `legacy-open`,
which has full permissions. That lets services move across one at a time.

**Until step 3 is done, this config does not restrict anything.** Step 3 is the
step that closes the door.

### 1. Deploy the config with the shim in place

Put all `NATS_PASS_*` values in `infrastructure/.env`, then recreate the server
so it picks up the new environment (a reload alone will not add new env vars):

```bash
cd infrastructure
docker compose up -d --no-deps nats
docker compose logs --tail 20 nats      # expect no config errors
```

Nothing has changed for existing clients — they are still unauthenticated, now
mapped to `legacy-open`.

### 2. Move clients across, one at a time

For each project, add its `NATS_PASS_*` to that project's `.env`, then recreate
just that service. After each one, confirm it reconnected as its own user and
that its traffic still flows:

```bash
docker compose up -d --no-deps <service>

# Who is connected as what:
docker exec <any-container-on-corporate-backend> \
  curl -s 'http://nats:8222/connz?auth=1' |
  python3 -c 'import json,sys; [print(c["authorized_user"]) for c in json.load(sys.stdin)["connections"]]' |
  sort | uniq -c
```

anchor-weather's services take their `NATS_URL` from that project's own `.env`
and need no code change. The `container-control` daemon is a host systemd unit,
not a container — update its `NATS_URL` in the unit environment and
`systemctl restart container-control`.

A service that fails to authenticate will log a connection error and keep
retrying; put its old `NATS_URL` back and it recovers.

### 3. Close the door

Once no connection reports `legacy-open`:

```bash
docker exec <any-container-on-corporate-backend> \
  curl -s 'http://nats:8222/connz?auth=1' | grep -c '"authorized_user":"legacy-open"'
# must be 0
```

Delete from `nats.conf`:

- the `no_auth_user: legacy-open` line
- the `legacy-open` entry in `users`
- the `LEGACY_OPEN` permission block

and from `.env` / `docker-compose.yml`, `NATS_PASS_LEGACY_OPEN`. Then recreate
the server. Unauthenticated connections are now refused.

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
