#!/bin/bash
#
# Safe, targeted deploy for the roitsystems-infra stack.
#
# This droplet is SHARED with the anchor-weather production stack, and the
# Caddy container in infrastructure/ is the TLS edge for anchor-weather's
# public domains as well as our own. The previous version of this script
# did `docker-compose down -v` (destroying the CouchDB, NATS JetStream and
# Caddy TLS-certificate volumes) and `docker system prune -af` (deleting
# images host-wide, including from under a concurrently running
# anchor-weather deploy). This version is built around the opposite rules:
#
#   1. NEVER `down`, NEVER `-v`, NEVER `prune`. Convergence only:
#      `docker compose up -d` recreates exactly the containers whose
#      config/image changed and leaves everything else running.
#   2. NEVER touch the anchor-weather containers. Verified, not assumed:
#      their container IDs are snapshotted before and after and compared.
#   3. Caddy is never restarted without --allow-caddy-restart, because
#      restarting it drops anchor-weather's public edge. Caddyfile changes
#      are applied with a zero-downtime `caddy reload` instead. Other
#      infrastructure services are converged with --no-deps so a NATS or
#      CouchDB recreate can't cascade into a Caddy recreate.
#   4. `docker compose` v2 only. docker-compose v1 (1.29.2) is broken on
#      this host (KeyError: 'ContainerConfig' mid-recreate, which leaves
#      the service DOWN behind a renamed zombie container).
#
# Usage:
#   ./deploy.sh [--dry-run] [--allow-caddy-restart] [target ...]
#
#   Targets: infrastructure | contact-inbox | image-converter
#   No target = all three, in that order.
#
#   --dry-run              Show what would be pulled/recreated; change nothing.
#   --allow-caddy-restart  Permit a Caddy container recreate (brief outage
#                          for ALL domains on this host, anchor-weather
#                          included). Only needed when caddy's compose
#                          config or image changed; plain Caddyfile edits
#                          never need it.
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
die()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

DRY_RUN=0
ALLOW_CADDY_RESTART=0
TARGETS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --allow-caddy-restart) ALLOW_CADDY_RESTART=1 ;;
    infrastructure|contact-inbox|image-converter) TARGETS+=("$arg") ;;
    *) die "Unknown argument: $arg (targets: infrastructure contact-inbox image-converter)" ;;
  esac
done
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(infrastructure contact-inbox image-converter)

# ── Preconditions ──────────────────────────────────────────────────────────

docker compose version >/dev/null 2>&1 \
  || die "docker compose v2 is required. Do NOT fall back to docker-compose v1 — it is broken on this host and leaves services down mid-recreate."

# One deploy at a time; a second invocation exits instead of interleaving.
exec 200>/var/lock/roitsystems-infra-deploy.lock
flock -n 200 || die "Another deploy is already running (lock: /var/lock/roitsystems-infra-deploy.lock)."

# Refuse to deploy over local edits to tracked files: a pull would either
# fail or silently deploy a mixture of main and hand-edits. Stash first.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no
  die "Tracked files have local modifications. Stash or commit them first (git stash push -m 'pre-deploy')."
fi

# ── Snapshot anchor-weather (rule 2: verified, not assumed) ────────────────

aw_snapshot() {
  docker ps --filter "name=anchor-weather" --format "{{.ID}} {{.Names}}" | sort
}
AW_BEFORE="$(aw_snapshot)"
[ -n "$AW_BEFORE" ] || warn "No anchor-weather containers found — snapshot check will pass trivially."

# ── Update the checkout ────────────────────────────────────────────────────

if [ "$DRY_RUN" -eq 1 ]; then
  git fetch origin main
  log "[dry-run] Would fast-forward $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
else
  log "Updating checkout (fast-forward only)..."
  git pull --ff-only origin main
fi
log "Deploying commit: $(git log --oneline -1)"

# ── Helpers ────────────────────────────────────────────────────────────────

require_env() {
  [ -f "$1/.env" ] || die "$1/.env not found — refusing to start services with missing secrets."
}

compose_in() {  # compose_in <dir> <args...>
  local dir="$1"; shift
  docker compose --project-directory "$REPO_ROOT/$dir" -f "$REPO_ROOT/$dir/docker-compose.yml" "$@"
}

# Converge one project. $3 (optional) = extra `up` args, e.g. --build.
converge() {  # converge <dir> <services...>
  local dir="$1"; shift
  if [ "$DRY_RUN" -eq 1 ]; then
    compose_in "$dir" up -d --dry-run --no-deps "$@" 2>&1 | sed "s|^|  [dry-run:$dir] |"
  else
    compose_in "$dir" up -d --no-deps "$@"
  fi
}

# ── Per-project deploys ────────────────────────────────────────────────────

deploy_infrastructure() {
  log "=== infrastructure (caddy / nats / couchdb) ==="
  require_env infrastructure

  # Everything except caddy: converge with --no-deps so a nats/couchdb
  # recreate can never cascade into the shared Caddy edge.
  local others
  others=$(compose_in infrastructure config --services | grep -v '^caddy$')
  # shellcheck disable=SC2086  # word-splitting the service list is intended
  converge infrastructure $others

  # Caddy: find out whether ITS OWN config/image changed (--no-deps
  # isolates it from the nats/couchdb recreates above).
  local caddy_plan
  caddy_plan=$(compose_in infrastructure up -d --dry-run --no-deps caddy 2>&1 || true)
  if echo "$caddy_plan" | grep -qE "caddy.*(Recreate|Create)"; then
    echo "$caddy_plan" | grep -E "caddy" | sed 's|^|    plan: |'
    if [ "$ALLOW_CADDY_RESTART" -eq 1 ]; then
      warn "Caddy compose config/image changed — recreating WITH --allow-caddy-restart."
      warn "This briefly drops EVERY domain on this host, anchor-weather included."
      [ "$DRY_RUN" -eq 1 ] || compose_in infrastructure up -d --no-deps caddy
    else
      warn "Caddy's compose config or image has changed, but Caddy fronts the"
      warn "anchor-weather production domains — refusing to restart it without"
      warn "--allow-caddy-restart. Everything else has been deployed."
      CADDY_SKIPPED=1
    fi
  else
    # Caddy container unchanged. Pick up any Caddyfile edits with a
    # zero-downtime graceful reload (no-op if the file didn't change).
    if [ "$DRY_RUN" -eq 1 ]; then
      log "[dry-run] Would run: caddy reload (zero-downtime config pickup)"
    else
      compose_in infrastructure exec -T caddy caddy reload --config /etc/caddy/Caddyfile \
        && log "Caddy config reloaded gracefully." \
        || warn "caddy reload failed — the running config is unchanged; investigate before retrying."
    fi
  fi
}

deploy_app() {  # deploy_app <dir> — contact-inbox / image-converter
  local dir="$1"
  log "=== $dir ==="
  require_env "$dir"
  # --build: rebuild images from the pulled source; compose only recreates
  # containers whose image or config actually changed. A failed build
  # leaves the currently-running containers untouched.
  converge "$dir" --build
}

for t in "${TARGETS[@]}"; do
  case "$t" in
    infrastructure)  deploy_infrastructure ;;
    contact-inbox)   deploy_app corporate-network/contact-inbox ;;
    image-converter) deploy_app corporate-network/image-converter ;;
  esac
done

# ── Verification ───────────────────────────────────────────────────────────

[ "$DRY_RUN" -eq 1 ] && { log "Dry run complete — nothing was changed."; exit 0; }

log "=== VERIFYING ==="

AW_AFTER="$(aw_snapshot)"
if [ "$AW_BEFORE" = "$AW_AFTER" ]; then
  log "✓ anchor-weather containers untouched ($(echo "$AW_BEFORE" | grep -c . ) running, same IDs)"
else
  warn "✗ anchor-weather container set CHANGED during this deploy:"
  diff <(echo "$AW_BEFORE") <(echo "$AW_AFTER") | sed 's/^/    /' || true
  warn "Investigate immediately — this script must never affect anchor-weather."
fi

log "Container status:"
for t in "${TARGETS[@]}"; do
  case "$t" in
    infrastructure)  compose_in infrastructure ps ;;
    contact-inbox)   compose_in corporate-network/contact-inbox ps ;;
    image-converter) compose_in corporate-network/image-converter ps ;;
  esac
done

# NATS must answer on host loopback (and only loopback — see
# HARDENING_CHECKLIST.md for the off-host half of this check).
if timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/4222' 2>/dev/null; then
  log "✓ NATS answering on 127.0.0.1:4222"
else
  warn "✗ NATS not reachable on 127.0.0.1:4222"
fi

if curl -fsS --max-time 10 https://pubapi.roitsystems.ca/health >/dev/null 2>&1; then
  log "✓ contact-inbox health endpoint OK"
else
  warn "Health endpoint not responding yet — containers may still be starting (docker logs contact-inbox-api)"
fi

if [ "${CADDY_SKIPPED:-0}" -eq 1 ]; then
  warn "REMINDER: Caddy was NOT restarted. Re-run with --allow-caddy-restart"
  warn "in a low-traffic window to apply its pending compose/image change."
fi

log "=== DEPLOYMENT COMPLETE ==="
