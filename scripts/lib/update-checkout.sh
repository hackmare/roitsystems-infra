# shellcheck shell=bash
# Sourced by deploy.sh: bring the checkout up to date, fast-forward only.
#
#   update_checkout <dry_run 0|1>
#
# With DEPLOY_COMMIT set (a full commit id, as the deploy gate passes it), a real
# deploy fast-forwards to exactly that commit, which must already be on
# origin/main, instead of to whatever origin/main is by now: a push after the dry
# run can't slip in. Without it, it fast-forwards to origin/main as before.
# A dry run moves nothing: it sets PLAN_COMMIT to the commit a real deploy would
# move to, and plan_compose_file gives the compose files as they are there (#160).
# Needs log() and die() from the caller.
update_checkout() {
  local dry_run=$1
  git fetch -q origin main
  if [ "$dry_run" -eq 1 ]; then
    PLAN_COMMIT=$(git rev-parse origin/main)
    PLAN_DIR=$(mktemp -d)
    # shellcheck disable=SC2064  # expand PLAN_DIR now
    trap "rm -rf '$PLAN_DIR'" EXIT
    log "[dry-run] Would fast-forward $(git rev-parse --short HEAD) -> ${PLAN_COMMIT:0:7}; the plan below is for ${PLAN_COMMIT:0:7} (the checkout does not move)"
  elif [ -n "${DEPLOY_COMMIT:-}" ]; then
    [[ $DEPLOY_COMMIT =~ ^[0-9a-f]{40}$ ]] || die "DEPLOY_COMMIT must be a full 40-character commit id."
    git merge-base --is-ancestor "$DEPLOY_COMMIT" origin/main \
      || die "DEPLOY_COMMIT ${DEPLOY_COMMIT:0:7} is not on origin/main."
    log "Updating checkout to ${DEPLOY_COMMIT:0:7} (fast-forward only)..."
    git merge -q --ff-only "$DEPLOY_COMMIT"
  else
    log "Updating checkout (fast-forward only)..."
    git merge -q --ff-only origin/main
  fi
}

# plan_compose_file <dir>: print the path of a temporary copy of
# <dir>/docker-compose.yml as it is at PLAN_COMMIT. Use it with
# --project-directory set to the live <dir>: .env, the project name and
# relative paths then resolve as in a real deploy, so `up --dry-run` compares
# the target commit's compose file with the running containers.
# Limit: only the compose file comes from PLAN_COMMIT; build contexts and
# mounted files are read from the checkout (Compose doesn't hash them for its
# recreate decision anyway).
plan_compose_file() {
  local dir=$1 f
  # Runs inside $(...): errors go to stderr and return 1, the caller exits.
  if [ -z "${PLAN_COMMIT:-}" ] || [ ! -d "${PLAN_DIR:-}" ]; then
    echo "[ERROR] no dry-run plan: call update_checkout 1 first." >&2; return 1
  fi
  f="$PLAN_DIR/${dir//\//_}.yml"
  if [ ! -f "$f" ] && ! git show "$PLAN_COMMIT:$dir/docker-compose.yml" > "$f" 2>/dev/null; then
    rm -f "$f"
    echo "[ERROR] $dir/docker-compose.yml not found at ${PLAN_COMMIT:0:7}." >&2; return 1
  fi
  echo "$f"
}
