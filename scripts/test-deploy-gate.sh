#!/usr/bin/env bash
# Tests for scripts/deploy-gate.sh and scripts/lib/update-checkout.sh, in a throwaway
# git checkout. The gate runs from a copy outside the checkout, as installed; a stub
# deploy.sh uses the real update-checkout.sh and prints compose-like lines.
# Needs only bash and git. Exits non-zero on any failure.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
failures=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi; }

git init -q --bare -b main "$W/origin.git"
git clone -q "$W/origin.git" "$W/repo" 2>/dev/null
cd "$W/repo"
git config user.email gate@example.invalid; git config user.name gate
mkdir -p scripts/lib
cp "$HERE/deploy-gate.sh" scripts/
cp "$HERE/lib/update-checkout.sh" scripts/lib/
cat > deploy.sh <<'STUB'
#!/usr/bin/env bash
log() { echo "[INFO] $1"; }; die() { echo "[ERROR] $1"; exit 1; }
. scripts/lib/update-checkout.sh
dry=0; [[ ${1:-} == --dry-run ]] && { dry=1; shift; }
update_checkout "$dry"
echo "dry=$dry target=$1 commit=${DEPLOY_COMMIT:-} head=$(git rev-parse HEAD)" >> "$CALLS"
if [ "$dry" -eq 1 ]; then
  echo "  [dry-run:x] DRY-RUN MODE -  Container $1-api  Recreate"
else
  echo " Container $1-api  Recreated"
  echo -e "\e[1;33m[WARN]\e[0m PRIVATE-DETAIL anchor-weather-abc123 changed"
fi
STUB
chmod +x deploy.sh scripts/deploy-gate.sh
git add -A && git commit -qm base && git push -q origin main

mkdir -p "$W/sbin" && cp "$HERE/deploy-gate.sh" "$W/sbin/roitsystems-deploy-gate" && chmod 755 "$W/sbin/roitsystems-deploy-gate"
export CALLS="$W/calls" DEPLOY_GATE_REPO="$W/repo" DEPLOY_GATE_STATE_DIR="$W/state" DEPLOY_GATE_LOG_DIR="$W/log"
GATE="$W/sbin/roitsystems-deploy-gate"
gate() { : > "$CALLS"; SSH_ORIGINAL_COMMAND="$1" "$GATE" >"$W/out" 2>&1; echo $? > "$W/rc"; }
rc() { cat "$W/rc"; }
calls() { cat "$CALLS"; }
out() { cat "$W/out"; }
git clone -q "$W/origin.git" "$W/other" 2>/dev/null
push_elsewhere() {  # someone else pushes to main
  (cd "$W/other" && git pull -q origin main && git -c user.email=o@example.invalid -c user.name=o \
    commit -q --allow-empty -m "$1" && git push -q origin HEAD:main)
}

: > "$CALLS"; SSH_ORIGINAL_COMMAND='dry-run contact-inbox' "$W/repo/scripts/deploy-gate.sh" >"$W/out" 2>&1; echo $? > "$W/rc"
check 'the copy inside the checkout refuses to run' '[[ $(rc) == 2 && -z $(calls) ]] && grep -q "installed copy" "$W/out"'

for bad in '' 'deploy' 'dry-run' 'deploy nowhere' 'dry-run contact-inbox extra' 'deploy contact-inbox --allow-caddy-restart' \
  'dry-run contact-inbox; id' 'dry-run contact-inbox && id' $'dry-run contact-inbox\nid' 'bash' '--dry-run contact-inbox' 'DRY-RUN contact-inbox'; do
  gate "$bad"
  check "refuses $(printf %q "$bad")" '[[ $(rc) == 2 && -z $(calls) ]]'
done

gate 'deploy contact-inbox'
check 'refuses a deploy with no dry run on record' '[[ $(rc) == 2 && -z $(calls) ]] && grep -q "no dry run" "$W/out"'

gate 'dry-run contact-inbox'
main_now=$(git -C "$W/repo" rev-parse origin/main)
check 'runs a dry run as deploy.sh --dry-run <target>' '[[ $(rc) == 0 ]] && grep -q "^dry=1 target=contact-inbox commit= " "$CALLS"'
check 'the dry run reports only a summary: result, commit, containers, warnings' \
  'out | grep -q "dry run of contact-inbox at ${main_now:0:7} succeeded; containers: contact-inbox-api; warnings: 0" && ! out | grep -q "DRY-RUN MODE"'
gate 'deploy image-converter'
check 'a dry run of one target does not allow deploying another' '[[ $(rc) == 2 && -z $(calls) ]]'
gate 'deploy contact-inbox'
check 'deploys after a dry run, passing the dry-run commit as DEPLOY_COMMIT' \
  '[[ $(rc) == 0 ]] && grep -q "^dry=0 target=contact-inbox commit=$main_now head=$main_now" "$CALLS"'
check 'the deploy summary counts the warning but does not show it' \
  'out | grep -q "deploy of contact-inbox at ${main_now:0:7} succeeded; containers: contact-inbox-api; warnings: 1" && ! out | grep -q "PRIVATE-DETAIL"'
logf=$(ls -t "$W/log" | head -1)
check "the full output is kept in a file only its owner can read" \
  'grep -q "PRIVATE-DETAIL" "$W/log/$logf" && [[ $(stat -c %a "$W/log/$logf" 2>/dev/null || stat -f %Lp "$W/log/$logf") == 600 ]]'
gate 'deploy contact-inbox'
check 'one dry run allows one deploy' '[[ $(rc) == 2 && -z $(calls) ]]'

gate 'dry-run infrastructure'
push_elsewhere newer
gate 'deploy infrastructure'
check 'refuses a deploy when main moved after the dry run' '[[ $(rc) == 2 && -z $(calls) ]] && grep -q "main has moved" "$W/out"'

gate 'dry-run image-converter'
read -r _ commit < "$DEPLOY_GATE_STATE_DIR/dry-run-image-converter"
echo "$(( $(date +%s) - 31 * 60 )) $commit" > "$DEPLOY_GATE_STATE_DIR/dry-run-image-converter"
gate 'deploy image-converter'
check 'refuses a deploy when the dry run is over 30 minutes old' '[[ $(rc) == 2 && -z $(calls) ]] && grep -q "over 30 minutes" "$W/out"'

# update_checkout itself: DEPLOY_COMMIT pins the deploy to the dry-run commit, even if
# someone else pushes to main in between.
uc() { (cd "$W/repo"; log() { :; }; die() { echo "DIE $1"; exit 1; }; . scripts/lib/update-checkout.sh; "$@") > "$W/pin" 2>&1; }
git -C "$W/repo" fetch -q origin main
pinned=$(git -C "$W/repo" rev-parse origin/main)
git -C "$W/repo" reset -q --hard "$pinned~1"       # the server is one commit behind
push_elsewhere "pushed after the dry run"
uc env DEPLOY_COMMIT="$pinned" bash -c '. scripts/lib/update-checkout.sh; log() { :; }; die() { echo "DIE $1"; exit 1; }; update_checkout 0'
check 'with DEPLOY_COMMIT, the checkout moves to that commit, not to a newer main' \
  '[[ $(git -C "$W/repo" rev-parse HEAD) == "$pinned" && $(git -C "$W/repo" rev-parse origin/main) != "$pinned" ]]'
uc env DEPLOY_COMMIT=0123456789abcdef0123456789abcdef01234567 bash -c '. scripts/lib/update-checkout.sh; log() { :; }; die() { echo "DIE $1"; exit 1; }; update_checkout 0'
check 'a DEPLOY_COMMIT not on origin/main is refused' 'grep -q "DIE.*not on origin/main" "$W/pin"'
uc env DEPLOY_COMMIT='HEAD; id' bash -c '. scripts/lib/update-checkout.sh; log() { :; }; die() { echo "DIE $1"; exit 1; }; update_checkout 0'
check 'a DEPLOY_COMMIT that is not a full commit id is refused' 'grep -q "DIE.*full 40-character" "$W/pin"'
uc env -u DEPLOY_COMMIT bash -c '. scripts/lib/update-checkout.sh; log() { :; }; die() { echo "DIE $1"; exit 1; }; update_checkout 0'
check 'without DEPLOY_COMMIT, the checkout fast-forwards to origin/main as before' \
  '[[ $(git -C "$W/repo" rev-parse HEAD) == $(git -C "$W/repo" rev-parse origin/main) ]]'

echo "$([[ $failures -eq 0 ]] && echo 'all checks passed' || echo "$failures check(s) failed")"
exit $(( failures > 0 ))
