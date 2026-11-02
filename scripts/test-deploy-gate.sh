#!/usr/bin/env bash
# Tests for scripts/deploy-gate.sh, in a throwaway git checkout with a stub deploy.sh
# that records its arguments. Needs only bash and git. Exits non-zero on any failure.
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
mkdir scripts
cp "$HERE/deploy-gate.sh" scripts/
cat > deploy.sh <<'STUB'
#!/usr/bin/env bash
[[ ${1:-} == --dry-run ]] && git fetch -q origin main
echo "$*" >> "$CALLS"
STUB
chmod +x deploy.sh scripts/deploy-gate.sh
git add -A && git commit -qm base && git push -q origin main

export CALLS="$W/calls" DEPLOY_GATE_STATE_DIR="$W/state"
gate() { : > "$CALLS"; SSH_ORIGINAL_COMMAND="$1" scripts/deploy-gate.sh >"$W/out" 2>&1; echo $? > "$W/rc"; }
rc() { cat "$W/rc"; }
calls() { cat "$CALLS"; }

for bad in '' 'deploy' 'dry-run' 'deploy nowhere' 'dry-run contact-inbox extra' 'deploy contact-inbox --allow-caddy-restart' \
  'dry-run contact-inbox; id' 'dry-run contact-inbox && id' $'dry-run contact-inbox\nid' 'bash' '--dry-run contact-inbox' 'DRY-RUN contact-inbox'; do
  gate "$bad"
  check "refuses $(printf %q "$bad")" '[[ $(rc) == 2 && -z $(calls) ]]'
done

gate 'deploy contact-inbox'
check 'refuses a deploy with no dry run on record' '[[ $(rc) == 2 && -z $(calls) ]] && grep -q "no dry run" "$W/out"'

gate 'dry-run contact-inbox'
check 'runs a dry run as deploy.sh --dry-run <target>' '[[ $(rc) == 0 && $(calls) == "--dry-run contact-inbox" ]]'
gate 'deploy image-converter'
check 'a dry run of one target does not allow deploying another' '[[ $(rc) == 2 && -z $(calls) ]]'
gate 'deploy contact-inbox'
check 'deploys after a dry run of the same target, as deploy.sh <target>' '[[ $(rc) == 0 && $(calls) == "contact-inbox" ]]'
gate 'deploy contact-inbox'
check 'one dry run allows one deploy' '[[ $(rc) == 2 && -z $(calls) ]]'

gate 'dry-run infrastructure'
git commit -q --allow-empty -m newer && git push -q origin main
gate 'deploy infrastructure'
check 'refuses a deploy when main moved after the dry run' '[[ $(rc) == 2 && -z $(calls) ]] && grep -q "main has moved" "$W/out"'

gate 'dry-run image-converter'
read -r _ commit < "$DEPLOY_GATE_STATE_DIR/dry-run-image-converter"
echo "$(( $(date +%s) - 31 * 60 )) $commit" > "$DEPLOY_GATE_STATE_DIR/dry-run-image-converter"
gate 'deploy image-converter'
check 'refuses a deploy when the dry run is over 30 minutes old' '[[ $(rc) == 2 && -z $(calls) ]] && grep -q "over 30 minutes" "$W/out"'

echo "$([[ $failures -eq 0 ]] && echo 'all checks passed' || echo "$failures check(s) failed")"
exit $(( failures > 0 ))
