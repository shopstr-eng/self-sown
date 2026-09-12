#!/usr/bin/env bash
# Regression tests for scripts/deploy-build.sh (the Autoscale deploy build).
# Uses stub pnpm/next/node binaries so no real install or build runs — safe
# anywhere, a few seconds.
#
#   bash scripts/deploy-build.test.sh
#
# Pins the bundle-assembly step the same way scripts/dev-server.test.sh pins
# the preview supervisor: the REAL scripts/prepare-standalone.mjs is copied
# into the sandbox (only its Sharp-repair dependency is stubbed), so a drift
# in deploy-build.sh's invocation — wrong flag, wrong cwd, skipped call — or
# in the real script's CLI/output layout fails here instead of shipping a
# publish bundle missing static assets or with broken image optimization.
#
#   A. Happy path      -> assembly delegated with --strict-sharp, real script
#                         folds .next/static + public/ into the bundle, the
#                         rest of the build (cleanup, runtime bundle) runs
#   B. Sharp failure   -> --strict-sharp exits the build non-zero BEFORE the
#                         post-build cleanup (fail-loud contract)
#   C. Missing bundle  -> a build that produced no standalone server.js fails
#                         loudly too (guards against `|| true` creeping onto
#                         the assembly call)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_BUILD="$ROOT/scripts/deploy-build.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; exit $RESULT' EXIT
RESULT=1

REAL_NODE="$(command -v node)"

mkdir -p "$WORK/bin" "$WORK/scripts" "$WORK/home" "$WORK/tmp" "$WORK/.runtime/bin"

# Exercise the REAL bundle-assembly script the deploy build delegates to.
cp "$ROOT/scripts/prepare-standalone.mjs" "$WORK/scripts/"
# Only the Sharp repair is stubbed — the real repair needs a real pnpm
# standalone bundle. The stub records how it was invoked so the test still
# pins the --strict-sharp contract, and .sharp-broken simulates a repair
# failure.
cat > "$WORK/scripts/copy-sharp-standalone.mjs" <<'EOF'
import fs from "node:fs";
export function repairSharpStandalone() {
  if (fs.existsSync(".sharp-broken")) {
    throw new Error("STUB Sharp repair failure");
  }
  fs.writeFileSync(
    ".sharp-repair-called",
    process.argv.includes("--strict-sharp") ? "strict" : "non-strict"
  );
}
EOF

# Stub pnpm: install succeeds instantly, produces nothing.
cat > "$WORK/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

# Stub next: a "build" that emits a standalone server + static + cache but
# never folds static/public into the bundle — that is the real
# prepare-standalone.mjs's job, so the test detects a skipped assembly call.
# NEXT_STUB_NO_STANDALONE=1 simulates a build that produced no bundle.
cat > "$WORK/bin/next" <<'EOF'
#!/usr/bin/env bash
mkdir -p .next/static .next/cache
echo 'STATIC_MARKER' > .next/static/static-marker.txt
echo 'CACHE' > .next/cache/blob
if [ "${NEXT_STUB_NO_STANDALONE:-}" != "1" ]; then
  mkdir -p .next/standalone
  echo 'console.log("FRESH_SERVER up");' > .next/standalone/server.js
fi
exit 0
EOF

# Stub node: skip the real stylesheet marker check (needs a real build);
# everything else — the real prepare-standalone.mjs, the inline .next
# cleanup — runs on the real node.
cat > "$WORK/bin/node" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "scripts/check-globals-css.mjs" ]; then exit 0; fi
exec "$REAL_NODE" "\$@"
EOF

# Pre-bundled portable runtime so the curl/tar download block is skipped.
cat > "$WORK/.runtime/bin/node" <<'EOF'
#!/usr/bin/env bash
echo "v22.22.0-test"
EOF
chmod +x "$WORK/bin/"* "$WORK/.runtime/bin/node"

cd "$WORK"
export PATH="$WORK/bin:$PATH"
# Keep the script's $HOME and temp-dir cleanup inside the sandbox.
export HOME="$WORK/home"
export TMPDIR="$WORK/tmp"

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  PASS: $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL: $1"; }

reset_state() {
  rm -rf .next public .sharp-repair-called .sharp-broken
  mkdir -p public
  echo 'PUBLIC_MARKER' > public/marker.txt
}
run_deploy() { # run_deploy -> rc on stdout, log at /tmp/db-test.log
  timeout 120 bash "$DEPLOY_BUILD" > /tmp/db-test.log 2>&1
  echo $?
}

echo "== A: full deploy build folds static + public via the real script =="
reset_state
rc=$(run_deploy)
[ "$rc" -eq 0 ] && ok "deploy build exits zero" || bad "deploy build exits zero (rc=$rc)"
[ "$(cat .sharp-repair-called 2>/dev/null)" = "strict" ] && ok "assembly delegated with --strict-sharp" || bad "assembly delegated with --strict-sharp"
# The real prepare-standalone.mjs ran: it folds .next/static + public into
# the bundle (the stub `next` build never populates those inside standalone).
[ -f .next/standalone/.next/static/static-marker.txt ] && ok "real script folded .next/static into the bundle" || bad "real script folded .next/static into the bundle"
grep -qF PUBLIC_MARKER .next/standalone/public/marker.txt 2>/dev/null && ok "real script folded public/ into the bundle" || bad "real script folded public/ into the bundle"
# The rest of the build ran past the assembly step.
[ ! -e .next/static ] && [ ! -e .next/cache ] && ok "post-build cleanup kept only standalone inside .next" || bad "post-build cleanup kept only standalone inside .next"
[ ! -e public ] && ok "post-build cleanup removed top-level public/" || bad "post-build cleanup removed top-level public/"
grep -qF "bundled v22.22.0-test" /tmp/db-test.log && ok "portable runtime step reached" || bad "portable runtime step reached"

echo "== B: Sharp repair failure aborts the build before cleanup (--strict-sharp) =="
reset_state
touch .sharp-broken
rc=$(run_deploy)
[ "$rc" -ne 0 ] && ok "deploy build exits non-zero on Sharp failure" || bad "deploy build exits non-zero on Sharp failure"
if grep -qF "Post-build cleanup" /tmp/db-test.log; then bad "build aborted at the assembly step"; else ok "build aborted at the assembly step"; fi
[ -d public ] && ok "post-build cleanup never ran" || bad "post-build cleanup never ran"

echo "== C: missing standalone bundle fails loudly =="
reset_state
export NEXT_STUB_NO_STANDALONE=1
rc=$(run_deploy)
unset NEXT_STUB_NO_STANDALONE
[ "$rc" -ne 0 ] && ok "deploy build exits non-zero with no bundle" || bad "deploy build exits non-zero with no bundle"
grep -qF "server.js not found" /tmp/db-test.log && ok "real script's missing-bundle guard reported" || bad "real script's missing-bundle guard reported"
if grep -qF "Post-build cleanup" /tmp/db-test.log; then bad "build aborted at the assembly step"; else ok "build aborted at the assembly step"; fi

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && RESULT=0 || RESULT=1
exit $RESULT
