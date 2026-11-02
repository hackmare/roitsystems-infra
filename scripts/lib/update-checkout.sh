# Sourced by deploy.sh: bring the checkout up to date, fast-forward only.
#
#   update_checkout <dry_run 0|1>
#
# With DEPLOY_COMMIT set (a full commit id, as the deploy gate passes it), a real
# deploy fast-forwards to exactly that commit, which must already be on
# origin/main, instead of to whatever origin/main is by now: a push after the dry
# run can't slip in. Without it, it fast-forwards to origin/main as before.
# Needs log() and die() from the caller.
update_checkout() {
  local dry_run=$1
  git fetch -q origin main
  if [ "$dry_run" -eq 1 ]; then
    log "[dry-run] Would fast-forward $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
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
