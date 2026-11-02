#!/usr/bin/env bash
# Smoke test one service image against throwaway NATS (and CouchDB where needed).
#
#   IMAGE=<built image tag> scripts/smoke/run.sh <service>
#   scripts/smoke/run.sh --list
#
# Needs only bash and docker. Everything runs on a private docker network with a
# random suffix and is removed on exit, so parallel runs don't collide. NATS runs
# with JetStream where a service uses it, and CouchDB starts only for services
# that need it (clients/<service>.conf). The test client (clients/<service>.mjs) is
# copied into the running service container and run there with the image's own
# node and node_modules. Exits non-zero on any failure.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
NATS_IMAGE=nats:2.10-alpine
COUCH_IMAGE=couchdb:3.4

if [[ ${1:-} == --list ]]; then
  for f in "$HERE"/clients/*.mjs; do basename "$f" .mjs; done
  exit 0
fi

SERVICE=${1:-}
if [[ -z $SERVICE || ! -f $HERE/clients/$SERVICE.mjs ]]; then
  echo "usage: IMAGE=<tag> $0 <service>; services:" >&2
  "$0" --list >&2
  exit 2
fi
: "${IMAGE:?set IMAGE to the image tag to test}"

ID=smoke-$SERVICE-$RANDOM$RANDOM
NET=$ID
SVC=$ID-svc
cleanup() {
  docker rm -f "$SVC" "$ID-nats" "$ID-couch" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

NATS_URL=nats://$ID-nats:4222
COUCH_URL=http://$ID-couch:5984
COUCH_USER=smoke
COUCH_PASS=smoke-only-password

# Per-service start-up settings live in clients/<service>.conf (sourced; may set
# JETSTREAM=1, COUCH=1, the ENV array of extra `docker run` arguments, a setup
# function run once NATS and CouchDB are up, before the service starts, and a
# post_check function run after the client, e.g. to inspect the service's log).
# Dummy values only: nothing here reaches the internet.
JETSTREAM=0
COUCH=0
ENV=()
[[ -f $HERE/clients/$SERVICE.conf ]] && source "$HERE/clients/$SERVICE.conf"

docker network create "$NET" >/dev/null
if [[ $JETSTREAM -eq 1 ]]; then
  docker run -d --name "$ID-nats" --network "$NET" "$NATS_IMAGE" -js >/dev/null
else
  docker run -d --name "$ID-nats" --network "$NET" "$NATS_IMAGE" >/dev/null
fi
if [[ $COUCH -eq 1 ]]; then
  docker run -d --name "$ID-couch" --network "$NET" \
    -e COUCHDB_USER="$COUCH_USER" -e COUCHDB_PASSWORD="$COUCH_PASS" "$COUCH_IMAGE" >/dev/null
  # The services create their databases at start-up, so CouchDB must be up first.
  for _ in $(seq 60); do
    docker exec "$ID-couch" curl -sf http://localhost:5984/_up >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$ID-couch" curl -sf http://localhost:5984/_up >/dev/null || { echo "CouchDB did not start" >&2; exit 1; }
fi

if declare -F setup >/dev/null; then setup; fi

docker run -d --name "$SVC" --network "$NET" ${ENV[@]+"${ENV[@]}"} "$IMAGE" >/dev/null
sleep 2

docker cp "$HERE/clients/$SERVICE.mjs" "$SVC:/tmp/smoke-client.mjs"
status=0
docker exec -e NATS_URL="$NATS_URL" -e COUCH_URL="$COUCH_URL" -e COUCH_AUTH="$COUCH_USER:$COUCH_PASS" \
  -e SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-20}" "$SVC" \
  node /tmp/smoke-client.mjs || status=$?

if declare -F post_check >/dev/null; then post_check || status=1; fi

state=$(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' "$SVC")
echo "service container: $state"
[[ $state == running* ]] || status=1
if [[ $status -ne 0 ]]; then
  echo "---- service log (last 40 lines)"
  docker logs --tail 40 "$SVC" 2>&1
fi
echo "smoke $SERVICE: $([[ $status -eq 0 ]] && echo PASS || echo FAIL)"
exit "$status"
