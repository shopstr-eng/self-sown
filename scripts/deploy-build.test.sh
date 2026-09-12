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
#   D. Node download   -> the portable-Node tarball is checksum-verified
#                         before extraction; a matching download is bundled
#   E. Checksum mismatch -> a corrupted/tampered tarball fails the build
#                         loudly and is never extracted into the bundle
#   F. Stale pin       -> a SHASUMS256.txt that disagrees with the pinned
#                         NODE_SHA256 (someone bumped NODE_VERSION without the
#                         pin) fails the build with the update-together
#                         message, before any extraction
#   G. Missing entry   -> a SHASUMS256.txt with NO entry for the tarball
#                         filename (typo'd NODE_VERSION, wrong arch suffix, or
#                         a pulled release) fails the build with the
#                         not-found message, before any extraction
#   H. Guard           -> without the publish-only marker the script refuses
#                         to run and deletes nothing
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

# Download fixtures for the checksum-verification scenarios: a fake portable
# Node dist tarball, the SHASUMS256.txt the stub curl serves for it, and a
# corrupted variant of the same tarball (valid xz, different bytes).
mkdir -p "$WORK/fixtures/dist/node-v22.22.0-linux-x64/bin"
cat > "$WORK/fixtures/dist/node-v22.22.0-linux-x64/bin/node" <<'EOF'
#!/usr/bin/env bash
echo "v22.22.0-downloaded"
EOF
chmod +x "$WORK/fixtures/dist/node-v22.22.0-linux-x64/bin/node"
tar -cJf "$WORK/fixtures/node-good.tar.xz" -C "$WORK/fixtures/dist" node-v22.22.0-linux-x64
FIXTURE_SHA="$(sha256sum "$WORK/fixtures/node-good.tar.xz" | awk '{print $1}')"
printf '%s  %s\n' "$FIXTURE_SHA" "node-v22.22.0-linux-x64.tar.xz" > "$WORK/fixtures/SHASUMS256.txt"
echo '# tampered' >> "$WORK/fixtures/dist/node-v22.22.0-linux-x64/bin/node"
tar -cJf "$WORK/fixtures/node-corrupt.tar.xz" -C "$WORK/fixtures/dist" node-v22.22.0-linux-x64
rm -rf "$WORK/fixtures/dist"
# A SHASUMS256.txt that disagrees with the pin, simulating nodejs.org after a
# NODE_VERSION bump that forgot NODE_SHA256. The stale entry must not be a
# real checksum of anything the sandbox serves — the point is that the pin
# stops matching the published file.
printf '%s  %s\n' "$(printf '%s' "$FIXTURE_SHA" | tr '0-9a-f' '1-9a-f0')" "node-v22.22.0-linux-x64.tar.xz" > "$WORK/fixtures/SHASUMS256-stale.txt"
# A SHASUMS256.txt with no entry for the tarball filename at all, simulating
# nodejs.org after a NODE_VERSION bump to a release/arch that was never (or is
# no longer) published. It is a well-formed checksum file for OTHER files — the
# lookup must come back empty, not error.
printf '%s  %s\n' "$FIXTURE_SHA" "node-v22.22.0-linux-arm64.tar.xz" > "$WORK/fixtures/SHASUMS256-missing.txt"

# Stub curl: serves the Node tarball and SHASUMS256.txt from the fixtures
# above. CURL_SERVE_CORRUPT=1 serves the corrupted tarball.
# CURL_SERVE_STALE_SHASUMS=1 serves a SHASUMS256.txt that disagrees with the
# pinned checksum (the version-bump-without-pin case).
# CURL_SERVE_MISSING_SHASUMS=1 serves a SHASUMS256.txt that has no entry for
# the tarball filename (an unpublished/pulled version or wrong arch suffix).
cat > "$WORK/bin/curl" <<EOF
#!/usr/bin/env bash
out=""
url=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o) out="\$2"; shift 2 ;;
    -*) shift ;;
    *) url="\$1"; shift ;;
  esac
done
case "\$url" in
  *SHASUMS256.txt)
    if [ "\${CURL_SERVE_STALE_SHASUMS:-}" = "1" ]; then
      src="$WORK/fixtures/SHASUMS256-stale.txt"
    elif [ "\${CURL_SERVE_MISSING_SHASUMS:-}" = "1" ]; then
      src="$WORK/fixtures/SHASUMS256-missing.txt"
    else
      src="$WORK/fixtures/SHASUMS256.txt"
    fi ;;
  *.tar.xz)
    if [ "\${CURL_SERVE_CORRUPT:-}" = "1" ]; then
      src="$WORK/fixtures/node-corrupt.tar.xz"
    else
      src="$WORK/fixtures/node-good.tar.xz"
    fi ;;
  *) echo "STUB curl: unexpected URL \$url" >&2; exit 1 ;;
esac
if [ -n "\$out" ]; then cp "\$src" "\$out"; else cat "\$src"; fi
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
  # Scenarios A-G simulate the publish environment, which is the only place
  # the [deployment] build command in .replit sets this marker.
  SELF_SOWN_PUBLISH_BUILD=1 timeout 120 bash "$DEPLOY_BUILD" > /tmp/db-test.log 2>&1
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

echo "== D: Node download is checksum-verified before bundling =="
reset_state
# Drop the pre-bundled runtime so the real download/verify/extract block runs
# (against the stub curl + fixture tarball).
rm -rf .runtime
export NODE_TARBALL_SHA256="$FIXTURE_SHA"
rc=$(run_deploy)
unset NODE_TARBALL_SHA256
[ "$rc" -eq 0 ] && ok "deploy build exits zero" || bad "deploy build exits zero (rc=$rc)"
grep -qF "Verifying Node" /tmp/db-test.log && ok "checksum verification step ran" || bad "checksum verification step ran"
grep -qF "bundled v22.22.0-downloaded" /tmp/db-test.log && ok "verified tarball extracted and bundled" || bad "verified tarball extracted and bundled"
[ -x .runtime/bin/node ] && ok "bundled node is executable" || bad "bundled node is executable"

echo "== E: checksum mismatch fails the build before extraction =="
reset_state
rm -rf .runtime
export NODE_TARBALL_SHA256="$FIXTURE_SHA"
export CURL_SERVE_CORRUPT=1
rc=$(run_deploy)
unset NODE_TARBALL_SHA256 CURL_SERVE_CORRUPT
[ "$rc" -ne 0 ] && ok "deploy build exits non-zero on checksum mismatch" || bad "deploy build exits non-zero on checksum mismatch"
grep -qF "checksum mismatch" /tmp/db-test.log && ok "mismatch reported loudly" || bad "mismatch reported loudly"
[ ! -e .runtime/bin/node ] && ok "tampered tarball never bundled" || bad "tampered tarball never bundled"
if grep -qF "Final size" /tmp/db-test.log; then bad "build aborted at checksum verification"; else ok "build aborted at checksum verification"; fi

echo "== F: a stale NODE_SHA256 pin fails the build before extraction =="
reset_state
rm -rf .runtime
# Pin matches the tarball the stub curl serves, but nodejs.org's
# SHASUMS256.txt disagrees — the version-bump-without-pin case. The build
# must die on the update-together error, not the tampering error.
export NODE_TARBALL_SHA256="$FIXTURE_SHA"
export CURL_SERVE_STALE_SHASUMS=1
rc=$(run_deploy)
unset NODE_TARBALL_SHA256 CURL_SERVE_STALE_SHASUMS
[ "$rc" -ne 0 ] && ok "deploy build exits non-zero on stale pin" || bad "deploy build exits non-zero on stale pin"
grep -qF "update NODE_SHA256 together with NODE_VERSION" /tmp/db-test.log && ok "stale-pin error reported loudly" || bad "stale-pin error reported loudly"
if grep -qF "checksum mismatch" /tmp/db-test.log; then bad "stale pin not misreported as tampering"; else ok "stale pin not misreported as tampering"; fi
[ ! -e .runtime/bin/node ] && ok "nothing extracted or bundled" || bad "nothing extracted or bundled"
if grep -qF "Final size" /tmp/db-test.log; then bad "build aborted at the pin cross-check"; else ok "build aborted at the pin cross-check"; fi

echo "== G: a tarball absent from SHASUMS256.txt fails the build before extraction =="
reset_state
rm -rf .runtime
# Pin matches the tarball the stub curl serves, but nodejs.org's SHASUMS256.txt
# has no entry for the tarball filename — the typo'd-version / pulled-release /
# wrong-arch case. The build must die on the not-found error, not the
# update-together or tampering errors.
export NODE_TARBALL_SHA256="$FIXTURE_SHA"
export CURL_SERVE_MISSING_SHASUMS=1
rc=$(run_deploy)
unset NODE_TARBALL_SHA256 CURL_SERVE_MISSING_SHASUMS
[ "$rc" -ne 0 ] && ok "deploy build exits non-zero on missing SHASUMS entry" || bad "deploy build exits non-zero on missing SHASUMS entry"
grep -qF "not found in nodejs.org SHASUMS256.txt" /tmp/db-test.log && ok "missing-entry error reported loudly" || bad "missing-entry error reported loudly"
if grep -qF "update NODE_SHA256 together" /tmp/db-test.log; then bad "missing entry not misreported as stale pin"; else ok "missing entry not misreported as stale pin"; fi
if grep -qF "checksum mismatch" /tmp/db-test.log; then bad "missing entry not misreported as tampering"; else ok "missing entry not misreported as tampering"; fi
[ ! -e .runtime/bin/node ] && ok "nothing extracted or bundled" || bad "nothing extracted or bundled"
if grep -qF "Final size" /tmp/db-test.log; then bad "build aborted at the missing-entry guard"; else ok "build aborted at the missing-entry guard"; fi

echo "== H: without the publish marker the script refuses and deletes nothing =="
reset_state
# Sentinels for everything the destructive cleanup would remove: repo dirs,
# .git, $HOME caches, and a file under the temp dir.
mkdir -p node_modules .git __tests__ "$HOME/.cache" "$HOME/.local/share/pnpm"
echo 'KEEP' > node_modules/keep
echo 'KEEP' > .git/keep
echo 'KEEP' > __tests__/keep
echo 'KEEP' > "$HOME/.cache/keep"
echo 'KEEP' > "$HOME/.local/share/pnpm/keep"
echo 'KEEP' > "$TMPDIR/keep"
# No SELF_SOWN_PUBLISH_BUILD — this is a developer/agent running it by hand.
timeout 30 bash "$DEPLOY_BUILD" > /tmp/db-test.log 2>&1
rc=$?
[ "$rc" -ne 0 ] && ok "unmarked run exits non-zero" || bad "unmarked run exits non-zero"
grep -qF "Refusing to run" /tmp/db-test.log && ok "clear publish-only message printed" || bad "clear publish-only message printed"
if grep -qF "Pre-build cleanup" /tmp/db-test.log; then bad "refusal happens before any cleanup"; else ok "refusal happens before any cleanup"; fi
[ -f node_modules/keep ] && [ -f .git/keep ] && [ -f __tests__/keep ] && ok "repo dirs untouched" || bad "repo dirs untouched"
[ -f "$HOME/.cache/keep" ] && [ -f "$HOME/.local/share/pnpm/keep" ] && ok "HOME caches untouched" || bad "HOME caches untouched"
[ -f "$TMPDIR/keep" ] && ok "temp dir untouched" || bad "temp dir untouched"
rm -rf node_modules .git __tests__

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && RESULT=0 || RESULT=1
exit $RESULT
