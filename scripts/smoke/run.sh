#!/usr/bin/env bash
# Smoke test one service image against throwaway NATS (and CouchDB where needed).
#
#   IMAGE=<built image tag> scripts/smoke/run.sh <service>
#   scripts/smoke/run.sh --list
#
# Needs only bash and docker. Everything runs on a private docker network with a
# random suffix and is removed on exit, so parallel runs don't collide. The test
# client (clients/<service>.mjs) is copied into the running service container and
# run there with the image's own node and node_modules. Exits non-zero on any failure.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
NATS_IMAGE=nats:2.10-alpine

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
  docker rm -f "$SVC" "$ID-nats" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NET" >/dev/null
docker run -d --name "$ID-nats" --network "$NET" "$NATS_IMAGE" >/dev/null
NATS_URL=nats://$ID-nats:4222

# Per-service start-up settings. Dummy values only: nothing here reaches the internet.
case $SERVICE in
  image-converter-imagemagick-service)
    # Same memory cap as docker-compose.yml.
    ENV=(-e NATS_URL="$NATS_URL" --memory 512m)
    ;;
esac

docker run -d --name "$SVC" --network "$NET" "${ENV[@]}" "$IMAGE" >/dev/null
sleep 2

docker cp "$HERE/clients/$SERVICE.mjs" "$SVC:/tmp/smoke-client.mjs"
status=0
docker exec -e NATS_URL="$NATS_URL" -e SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-20}" "$SVC" \
  node /tmp/smoke-client.mjs || status=$?

state=$(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' "$SVC")
echo "service container: $state"
[[ $state == running* ]] || status=1
if [[ $status -ne 0 ]]; then
  echo "---- service log (last 40 lines)"
  docker logs --tail 40 "$SVC" 2>&1
fi
echo "smoke $SERVICE: $([[ $status -eq 0 ]] && echo PASS || echo FAIL)"
exit "$status"
