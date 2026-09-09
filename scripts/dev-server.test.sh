#!/usr/bin/env bash
# Regression tests for scripts/dev-server.sh (the dev-preview supervisor).
# Uses a stub `next` binary so no real build runs — safe anywhere, ~15s.
#
#   bash scripts/dev-server.test.sh
#
# Covers the failure classifications the supervisor must get right:
#   A. OOM kills (137) then success        -> fresh build swapped in
#   B. OOM kills forever + last-good       -> last-good served, self-heal swap
#   C. Real compile error, no last-good    -> "broken" status, no retries
#   D. Real compile error, with last-good  -> keeps serving last-good
#   E. OOM exhaustion THEN a compile error -> loop stops, "broken" status
#      (regression: the background self-heal loop used to `|| continue` on
#      ANY failure, so a compile error after OOM kills retried forever and
#      the status page kept claiming "retrying automatically")
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPERVISOR="$ROOT/scripts/dev-server.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; exit $RESULT' EXIT
RESULT=1

mkdir -p "$WORK/bin" "$WORK/public" "$WORK/scripts"
cp "$ROOT/scripts/dev-build-placeholder.mjs" "$WORK/scripts/"
echo 'console.log("copy-sharp ok");' > "$WORK/scripts/copy-sharp-standalone.mjs"
cd "$WORK"
export PATH="$WORK/bin:$PATH"
# Supervisor knobs: no memory gating, instant retries.
export COLD_REQUIRED_MB=1 WARM_REQUIRED_MB=1 WAIT_TIMEOUT_S=1 RETRY_INTERVAL_S=1 RETRY_BACKOFF_S=0

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  PASS: $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL: $1"; }
check(){ # check <desc> <expected-substring> <file>
  if grep -qF -- "$2" "$3"; then ok "$1"; else bad "$1 (missing: $2)"; fi
}

# Stub next: behaviour driven by $MODE (137 N times then X, or always X).
write_stub() { # write_stub <mode>
  cat > bin/next <<EOF
#!/usr/bin/env bash
f=.attempts; n=\$(( \$(cat \$f 2>/dev/null || echo 0) + 1 )); echo \$n > \$f
case "$1" in
  oom_then_ok)   [ "\$n" -lt 3 ] && exit 137 ;;
  always_oom)    [ "\$n" -lt 4 ] && exit 137 ;;
  compile_error) echo "FAKE build: real compile error"; exit 1 ;;
  oom_then_err)  if [ "\$n" -le 4 ]; then exit 137; else echo "FAKE: error"; exit 1; fi ;;
esac
mkdir -p .next/standalone/.next .next/static
echo 'console.log("FRESH_SERVER up");' > .next/standalone/server.js
exit 0
EOF
  chmod +x bin/next
}

reset() { rm -rf .next .next-last-good .next-last-good.prev .next-last-good.new .next-dev-status .attempts; }
run_supervisor() { # run_supervisor <timeout> -> log at /tmp/ds-test.log
  timeout "$1" bash "$SUPERVISOR" > /tmp/ds-test.log 2>&1
  return 0 # timeout's exit code is the assertion target via log content
}

echo "== A: OOM x2 then success =="
write_stub oom_then_ok; reset
run_supervisor 30
check "fresh build served after OOM retries" "serving .next/standalone/server.js" /tmp/ds-test.log
[ -f .next-last-good/server.js ] && ok "last-good snapshot saved" || bad "last-good snapshot saved"

echo "== B: OOM streak with last-good, self-heal swap =="
write_stub always_oom; reset
mkdir -p .next-last-good; echo 'console.log("LASTGOOD up");' > .next-last-good/server.js
run_supervisor 12
check "last-good served during OOM streak" "LASTGOOD up" /tmp/ds-test.log
check "background retry succeeded and swapped" "swapping in the fresh build" /tmp/ds-test.log

echo "== C: compile error, no last-good =="
write_stub compile_error; reset
run_supervisor 15
check "compile error reported once" "not a memory kill" /tmp/ds-test.log
[ "$(cat .next-dev-status 2>/dev/null)" = "broken" ] && ok "status is broken" || bad "status is broken"
if grep -q "retrying every" /tmp/ds-test.log; then bad "no retry loop on compile error"; else ok "no retry loop on compile error"; fi

echo "== D: compile error, last-good present =="
write_stub compile_error; reset
mkdir -p .next-last-good; echo 'console.log("LASTGOOD up");' > .next-last-good/server.js
run_supervisor 15
check "last-good kept serving on compile error" "LASTGOOD up" /tmp/ds-test.log
[ "$(cat .next-dev-status 2>/dev/null)" = "broken" ] && ok "status is broken" || bad "status is broken"

echo "== E: OOM exhaustion, THEN compile error (regression) =="
write_stub oom_then_err; reset
run_supervisor 15
check "OOM retries happened" "retrying every" /tmp/ds-test.log
check "compile error stops the loop" "not a memory kill" /tmp/ds-test.log
[ "$(cat .next-dev-status 2>/dev/null)" = "broken" ] && ok "status flips to broken" || bad "status flips to broken"
n=$(cat .attempts); [ "$n" -le 7 ] && ok "builds bounded ($n total, no infinite loop)" || bad "builds bounded (got $n)"

echo "== F: previous build's static chunks carried forward across a swap =="
# Regression: a rebuild used to replace .next/standalone wholesale, so tabs
# holding pre-rebuild HTML 404'd their content-hashed JS chunks, hydration
# died, and every HeroUI image (logo/avatars/product images) stayed invisible
# despite the server returning 200s.
write_stub oom_then_ok; reset
mkdir -p .next-last-good/.next/static/chunks
echo 'console.log("LASTGOOD up");' > .next-last-good/server.js
echo 'OLD_CHUNK' > .next-last-good/.next/static/chunks/old-chunk.js
run_supervisor 30
check "carry-forward logged" "carried forward previous build's static assets" /tmp/ds-test.log
[ -f .next-last-good/.next/static/chunks/old-chunk.js ] && ok "old chunk survives swap" || bad "old chunk survives swap"
[ -f .next-last-good.prev/server.js ] && ok "previous generation retained as .prev" || bad "previous generation retained as .prev"
grep -q FRESH_SERVER .next-last-good/server.js && ok "last-good promoted to fresh build" || bad "last-good promoted to fresh build"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && RESULT=0 || RESULT=1
exit $RESULT
