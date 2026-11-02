#!/usr/bin/env bash
# Forced command for the deploy workflow's SSH key (.github/workflows/deploy-manual.yml).
# The key's authorized_keys line runs this script whatever the client asks for; the
# request arrives in SSH_ORIGINAL_COMMAND and must be exactly one of:
#
#   dry-run <target>    ./deploy.sh --dry-run <target>, and remember which main commit it showed
#   deploy <target>     ./deploy.sh <target>, only after a dry run of that target in the
#                       last 30 minutes, and only if main hasn't moved since
#
# <target> is infrastructure, contact-inbox or image-converter. Nothing else runs:
# no shell, no other arguments, and never --allow-caddy-restart. See DEPLOY.md.
set -euo pipefail

STATE_DIR=${DEPLOY_GATE_STATE_DIR:-/var/lib/roitsystems-deploy-gate}
MAX_AGE=$((30 * 60))

refuse() { echo "deploy-gate: $*" >&2; exit 2; }

request=${SSH_ORIGINAL_COMMAND:-}
[[ $request =~ ^(dry-run|deploy)\ (infrastructure|contact-inbox|image-converter)$ ]] \
  || refuse "expected 'dry-run <target>' or 'deploy <target>' (targets: infrastructure, contact-inbox, image-converter)"
action=${BASH_REMATCH[1]}
target=${BASH_REMATCH[2]}

cd "$(dirname "$(readlink -f "$0")")/.."
mkdir -p "$STATE_DIR"
stamp="$STATE_DIR/dry-run-$target"

case $action in
  dry-run)
    ./deploy.sh --dry-run "$target"
    # deploy.sh fetched origin/main to show what it would fast-forward to.
    echo "$(date +%s) $(git rev-parse origin/main)" > "$stamp"
    echo "deploy-gate: dry run of $target recorded for $(git rev-parse --short origin/main)"
    ;;
  deploy)
    [[ -f $stamp ]] || refuse "no dry run of $target on record; run 'dry-run $target' first"
    read -r when commit < "$stamp"
    (( $(date +%s) - when <= MAX_AGE )) || refuse "the dry run of $target is over 30 minutes old; run it again"
    git fetch -q origin main
    [[ $(git rev-parse origin/main) == "$commit" ]] \
      || refuse "main has moved since the dry run of $target; run the dry run again"
    rm -f "$stamp"   # one dry run, one deploy
    exec ./deploy.sh "$target"
    ;;
esac
