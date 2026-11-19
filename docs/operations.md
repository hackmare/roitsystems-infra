# Operations & Deployment

## Production layout

Production runs as **root** from the checkout at `/root/roitsystems-infra`, on a
server it shares with the Vector Weather (anchor-weather) stack. There is no
separate deploy user. Every command below runs as root in that folder unless it
says otherwise:

```bash
cd /root/roitsystems-infra
```

- Setting up a new server: [INSTALL.md](../INSTALL.md), "Production Deployment".
- Deploying and updating: [DEPLOY.md](../DEPLOY.md). Always `./deploy.sh --dry-run`
  first, then `./deploy.sh`. Never `docker compose down -v` or
  `docker system prune --volumes`: they delete the CouchDB and NATS data.

### Verify

```bash
# All containers running?
for d in infrastructure corporate-network/contact-inbox corporate-network/image-converter; do
  (cd "$d" && docker compose ps)
done

# Public API health
curl https://$API_DOMAIN/health
```

---

## Volumes & Persistence

| Volume | Data | Path in Container |
|--------|------|-------------------|
| `couchdb-data` | All contact messages | `/opt/couchdb/data` |
| `nats-data` | JetStream message log | `/data` |
| `caddy-data` | TLS certificates | `/data` |

All three belong to the `infrastructure/` project; `docker volume ls` shows
their full names. They survive rebuilds and redeploys. `docker compose down -v`
and `docker system prune --volumes` delete them, so never run either.

---

## Backup

Backups go under `/root/backups` (folder mode 0700, files 0600). Every
container in these commands uses the same pinned image:

```bash
ALPINE=alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
```

### Daily CouchDB backup

[`scripts/backup-couchdb.sh`](../scripts/backup-couchdb.sh) copies the
`infrastructure_couchdb-data` volume, read-only and with CouchDB still running,
to `/root/backups/couchdb/couchdb-data-<UTC time>.tgz`. It checks that the
archive reads back and keeps 14 days of its own archives. It deletes nothing
else. It refuses to run, and exits 1, unless the disk has more than twice
the volume's size free.

It runs from a root-owned copy in `/etc/cron.daily`, outside the checkout, so a
merge to `main` can't change what runs as root every day. **Install it** (and
re-install after the script changes) from a checkout that has it. This also
runs it once, so you see a first backup straight away:

```bash
install -m 0700 -o root -g root scripts/backup-couchdb.sh /etc/cron.daily/roitsystems-backup \
  && run-parts --test /etc/cron.daily | grep -x /etc/cron.daily/roitsystems-backup \
  && /etc/cron.daily/roitsystems-backup && ls -l /root/backups/couchdb | tail -3
```

**Expect:** the cron path printed, then `roitsystems-backup: wrote …`, then
the newest archive with `-rw-------`.

**Check it later:** `ls -lt /root/backups/couchdb | head -3`. The newest file
should be less than a day old.

**Remove it:** `rm /etc/cron.daily/roitsystems-backup`. The archives stay.

**Later step, not done yet:** these copies sit on the same server as the data.
Next come an off-box copy (to object storage or another host), an alert when
a run fails, and a monthly test restore of the newest archive into a throwaway
volume, to prove the backups can be read back into CouchDB.

### One-off CouchDB backup

The same copy, by hand, for example before a CouchDB upgrade:

```bash
install -d -m 700 /root/backups
docker run --rm -v infrastructure_couchdb-data:/data:ro -v /root/backups:/b "$ALPINE" \
  tar czf /b/couchdb-data-$(date -u +%Y%m%dT%H%MZ).tgz -C /data .
```

A live copy is normally usable because CouchDB writes its files append-only,
but it isn't a strict point-in-time copy. For a strict copy, stop CouchDB around
the `tar` (`(cd infrastructure && docker compose stop couchdb)`, then `start`).
While it is stopped, the contact forms can't save.

### NATS JetStream

```bash
docker run --rm -v infrastructure_nats-data:/data:ro -v /root/backups:/b "$ALPINE" \
  tar czf /b/nats-data-$(date -u +%Y%m%dT%H%MZ).tgz -C /data .
```

---

## Restore

Restoring **replaces** everything in the CouchDB volume with the archive. Only
restore with Morgane's go.

**Stop CouchDB and take a fresh one-off backup first** (above). The wipe below
can't be undone.

```bash
(cd infrastructure && docker compose stop couchdb)
docker run --rm -v infrastructure_couchdb-data:/data -v /root/backups/couchdb:/b "$ALPINE" \
  sh -c 'find /data -mindepth 1 -delete && tar xzf /b/<archive>.tgz -C /data'
(cd infrastructure && docker compose start couchdb)
```

---

## Health Monitoring

```bash
# Quick status
(cd infrastructure && docker compose ps)
(cd corporate-network/contact-inbox && docker compose ps)
(cd corporate-network/image-converter && docker compose ps)

# Container resource usage
docker stats --no-stream

# API health (set up an uptime monitor with UptimeRobot or Better Stack)
curl https://$API_DOMAIN/health
```

Set up an external uptime monitor on `https://$API_DOMAIN/health` for always-on alerting.

---

## Logs

```bash
# One project's services (run inside its folder)
(cd corporate-network/contact-inbox && docker compose logs -f)

# Single service
(cd corporate-network/contact-inbox && docker compose logs -f contact-inbox-api)
(cd corporate-network/contact-inbox && docker compose logs -f contact-inbox-worker)
(cd infrastructure && docker compose logs -f couchdb)

# Last 100 lines
(cd corporate-network/contact-inbox && docker compose logs --tail=100 contact-inbox-api)
```

Every container logs to the host's journal (the `journald` logging driver); `docker compose logs` still works. Retention is set once per server: see [DEPLOY.md](../DEPLOY.md), "Log retention".

---

## Common Operations

```bash
# Restart a single service
(cd corporate-network/contact-inbox && docker compose restart contact-inbox-api)

# Rebuild and restart after a code change (merged to main)
./deploy.sh contact-inbox

# Open a shell in the API container
(cd corporate-network/contact-inbox && docker compose exec contact-inbox-api sh)

# Inspect CouchDB directly
(cd infrastructure && docker compose exec couchdb sh -c \
  'curl -s -u "$COUCHDB_USER:$COUCHDB_PASSWORD" "http://localhost:5984/contact_messages/_all_docs?include_docs=true"')

# Check NATS stream info (the nats image has no shell or CLI, so use a throwaway
# nats-box container on the internal network, with a NATS user from nats.conf)
read -rs NATS_PASSWORD && export NATS_PASSWORD     # not echoed, not in the history
docker run --rm --network corporate-backend -e NATS_USER=<nats user> -e NATS_PASSWORD \
  natsio/nats-box:0.17.0 nats -s nats://nats:4222 stream info CONTACT_MESSAGES
unset NATS_PASSWORD
```
