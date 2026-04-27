#!/usr/bin/env bash
# Manual CouchDB initialisation helper.
# The API service creates databases automatically on startup;
# run this script only if you need to bootstrap without starting the full stack.
set -euo pipefail

COUCHDB_URL="${COUCHDB_URL:-http://localhost:5984}"
COUCHDB_USER="${COUCHDB_USER:?Set COUCHDB_USER}"
COUCHDB_PASSWORD="${COUCHDB_PASSWORD:?Set COUCHDB_PASSWORD}"

AUTH="-u ${COUCHDB_USER}:${COUCHDB_PASSWORD}"

echo "Waiting for CouchDB at ${COUCHDB_URL}…"
until curl -sf ${AUTH} "${COUCHDB_URL}/_up" > /dev/null 2>&1; do
  sleep 2
done
echo "CouchDB is up."

create_db() {
  local db="$1"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" -X PUT ${AUTH} "${COUCHDB_URL}/${db}")
  if [[ "$status" == "201" ]]; then
    echo "  Created: ${db}"
  elif [[ "$status" == "412" ]]; then
    echo "  Already exists: ${db}"
  else
    echo "  ERROR creating ${db}: HTTP ${status}"
    exit 1
  fi
}

echo "Creating databases…"
create_db "contact_messages"
create_db "bot_state"

echo "Done."
