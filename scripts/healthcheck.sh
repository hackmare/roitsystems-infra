#!/usr/bin/env bash
# System-wide health check for the RO IT Systems infra stack.
# Run from the host after `docker compose up -d`.
set -euo pipefail

API_DOMAIN="${API_DOMAIN:-localhost}"
COUCHDB_URL="${COUCHDB_URL:-http://localhost:5984}"
COUCHDB_USER="${COUCHDB_USER:-admin}"
COUCHDB_PASSWORD="${COUCHDB_PASSWORD:-}"

ok() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; FAILED=1; }

FAILED=0

echo "=== RO IT Systems Infra Health Check ==="

echo ""
echo "Docker services:"
docker compose ps --format "table {{.Name}}\t{{.Status}}" 2>/dev/null || fail "docker compose not available"

echo ""
echo "API:"
if curl -sf "https://${API_DOMAIN}/health" > /dev/null 2>&1; then
  ok "HTTPS /health"
else
  fail "HTTPS /health unreachable at https://${API_DOMAIN}/health"
fi

echo ""
echo "CouchDB (internal):"
if curl -sf -u "${COUCHDB_USER}:${COUCHDB_PASSWORD}" "${COUCHDB_URL}/_up" > /dev/null 2>&1; then
  ok "CouchDB /_up"
else
  fail "CouchDB unreachable at ${COUCHDB_URL}"
fi

echo ""
echo "CouchDB databases:"
for db in contact_messages bot_state; do
  if curl -sf -u "${COUCHDB_USER}:${COUCHDB_PASSWORD}" "${COUCHDB_URL}/${db}" > /dev/null 2>&1; then
    ok "${db}"
  else
    fail "${db} missing"
  fi
done

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo "All checks passed."
else
  echo "Some checks failed. Review the output above."
  exit 1
fi
