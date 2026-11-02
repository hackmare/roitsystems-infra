#!/usr/bin/env bash
# Forced command for the deploy workflow's SSH key (.github/workflows/deploy-manual.yml).
#
# Installed by hand OUTSIDE the checkout, root-owned, as
# /usr/local/sbin/roitsystems-deploy-gate (see DEPLOY.md), so that a change merged
# to main can't change the gate that decides what runs. It refuses to run from
# inside the checkout.
#
# The request arrives in SSH_ORIGINAL_COMMAND and must be exactly one of:
#
#   dry-run <target>    ./deploy.sh --dry-run <target>, and remember the main commit it showed
#   deploy <target>     ./deploy.sh <target> at exactly that commit, only after a dry run
#                       of the same target in the last 30 minutes, with main unmoved
#
# <target> is infrastructure, contact-inbox or image-converter. Nothing else runs:
# no shell, no other arguments, and never --allow-caddy-restart.
#
# deploy.sh's full output goes to a root-only file under LOG_DIR. The caller (and
# so the public Actions log) only gets the result, the commit, the containers
# recreated (or that would be) and how many warnings there were.
set -uo pipefail

REPO=${DEPLOY_GATE_REPO:-/root/roitsystems-infra}
STATE_DIR=${DEPLOY_GATE_STATE_DIR:-/var/lib/roitsystems-deploy-gate}
LOG_DIR=${DEPLOY_GATE_LOG_DIR:-/var/log/roitsystems-deploy}
MAX_AGE=$((30 * 60))
umask 077

refuse() { echo "deploy-gate: $*" >&2; exit 2; }

self=$(readlink -f "$0")
repo=$(readlink -f "$REPO") || refuse "repository not found"
[[ $self != "$repo"/* ]] || refuse "run the installed copy (/usr/local/sbin), not the one in the checkout"

request=${SSH_ORIGINAL_COMMAND:-}
[[ $request =~ ^(dry-run|deploy)\ (infrastructure|contact-inbox|image-converter)$ ]] \
  || refuse "expected 'dry-run <target>' or 'deploy <target>' (targets: infrastructure, contact-inbox, image-converter)"
action=${BASH_REMATCH[1]}
target=${BASH_REMATCH[2]}

mkdir -p "$STATE_DIR" "$LOG_DIR" || refuse "can't create the state or log folder"
stamp="$STATE_DIR/dry-run-$target"
logfile="$LOG_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$action-$target.log"
cd "$repo" || refuse "can't enter the repository"

# Run deploy.sh with its output going only to the root-only log file.
run() { "$@" > "$logfile" 2>&1; }

# What the caller sees: one summary line, nothing from deploy.sh's output itself.
summary() {  # summary <what> <exit code> <commit>
  local plain containers warnings
  plain=$(sed 's/\x1b\[[0-9;]*m//g' "$logfile")
  containers=$(grep -oE 'Container [A-Za-z0-9_.-]+ +(Recreate|Recreated|Create|Created)' <<<"$plain" \
    | awk '{print $2}' | sort -u | paste -sd ' ' -)
  warnings=$(grep -c '\[WARN\]' <<<"$plain")
  printf 'deploy-gate: %s of %s at %s %s; containers: %s; warnings: %s (full output on the server: %s)\n' \
    "$1" "$target" "${3:0:7}" "$([[ $2 -eq 0 ]] && echo succeeded || echo "FAILED (exit $2)")" \
    "${containers:-none}" "$warnings" "$(basename "$logfile")"
}

case $action in
  dry-run)
    run ./deploy.sh --dry-run "$target"; rc=$?
    commit=$(git rev-parse origin/main)   # deploy.sh fetched it to show the plan
    [[ $rc -eq 0 ]] && echo "$(date +%s) $commit" > "$stamp"
    summary "dry run" "$rc" "$commit"
    exit "$rc"
    ;;
  deploy)
    [[ -f $stamp ]] || refuse "no dry run of $target on record; run 'dry-run $target' first"
    read -r when commit < "$stamp"
    (( $(date +%s) - when <= MAX_AGE )) || refuse "the dry run of $target is over 30 minutes old; run it again"
    git fetch -q origin main || refuse "can't fetch main to check it"
    [[ $(git rev-parse origin/main) == "$commit" ]] \
      || refuse "main has moved since the dry run of $target; run the dry run again"
    rm -f "$stamp"   # one dry run, one deploy
    DEPLOY_COMMIT=$commit run ./deploy.sh "$target"; rc=$?
    summary "deploy" "$rc" "$commit"
    exit "$rc"
    ;;
esac
