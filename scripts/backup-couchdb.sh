#!/usr/bin/env bash
# Daily CouchDB backup for the production server.
#
# Installed by hand OUTSIDE the checkout, root-owned, as
# /etc/cron.daily/roitsystems-backup (see docs/operations.md, "Daily CouchDB
# backup"), so a change merged to main can't change what runs as root every day.
# Re-install after changing this file.
#
# Copies the infrastructure project's CouchDB volume, read-only, to
# /root/backups/couchdb/couchdb-data-<UTC time>.tgz (mode 0600), checks the
# archive reads back, and deletes this script's archives older than KEEP_DAYS.
# Nothing else in /root/backups is touched. CouchDB keeps running: its files are
# append-only, so a live copy is normally usable (not a strict point-in-time copy).
# Exits non-zero on any failure; cron logs it.
set -euo pipefail
umask 077

VOLUME=infrastructure_couchdb-data
DEST=/root/backups/couchdb
KEEP_DAYS=14
# The same pinned image as the prod catch-up plan's backup step.
ALPINE=alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf

docker volume inspect "$VOLUME" >/dev/null 2>&1 \
  || { echo "roitsystems-backup: volume $VOLUME not found" >&2; exit 1; }
install -d -m 0700 "$DEST"

name="couchdb-data-$(date -u +%Y%m%dT%H%M%SZ).tgz"
# Write to a .part file first, so an interrupted run never leaves a file that
# looks like a finished backup.
docker run --rm --network none \
  -v "$VOLUME":/data:ro -v "$DEST":/b \
  "$ALPINE" sh -c "umask 077 && tar czf /b/$name.part -C /data ."
tar tzf "$DEST/$name.part" >/dev/null
mv "$DEST/$name.part" "$DEST/$name"
chmod 0600 "$DEST/$name"

find "$DEST" -maxdepth 1 -name 'couchdb-data-*.tgz' -type f -mtime +"$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -name 'couchdb-data-*.part' -type f -mtime +1 -delete
echo "roitsystems-backup: wrote $DEST/$name ($(du -h "$DEST/$name" | cut -f1))"
