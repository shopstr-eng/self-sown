#!/usr/bin/env bash
# Dev-preview server: memory-bounded production build, then serve standalone.
#
# Why this wrapper exists: a cold Turbopack production build of this app
# (Next 16.3.4) used to peak at ~6.5-7GB against an ~8GiB VM with ~2GB of
# baseline usage outside our control, so builds died with SIGKILL (exit 137,
# or a misleading PostCSS "unexpected end of file" panic) many times in a
# row. The dominant cause turned out to be Tailwind v4's automatic source
# detection scanning the multi-GB .local/ and .cache/ directories during the
# globals.css compile (~4.4GB of the peak); globals.css now pins explicit
# @source globs (source(none)) and a cold build peaks at ~2.4GB. Host memory
# noise still fluctuates, so this supervisor keeps the safety nets:
#
#  1. Bind port 5000 IMMEDIATELY with a tiny status page (workflow port check
#     passes in seconds instead of timing out at 300s mid-build; if a
#     last-good bundle exists it is served instead so the preview is never
#     dead).
#  2. Memory gate + IDE kill: cold builds wait (up to WAIT_TIMEOUT_S) until
#     enough memory is free, and kill the IDE's TypeScript language servers
#     (~1.5-2.5GB, respawn lazily) when memory is tight.
#  3. Retries: SIGKILL-class failures (137/139/134) get MAX_ATTEMPTS initial
#     attempts; host memory noise fluctuates minute to minute, so a later
#     attempt often fits where an earlier one didn't.
#  4. Self-heal: if the initial attempts all OOM, keep retrying in the
#     background every RETRY_INTERVAL_S; when one finally fits, the status
#     page / last-good server is swapped for the fresh build automatically.
#     A REAL compile error (exit 1 etc.) stops the loop and flips the status
#     page to "broken" — it needs a code fix, not more attempts.
set -uo pipefail

export MM_DEV_BUILD=1
export NODE_OPTIONS='--max-old-space-size=3072'
# Cap Turbopack's Rust thread pool (rayon defaults to nproc); fewer concurrent
# module compilations = lower peak RSS.
export RAYON_NUM_THREADS="${RAYON_NUM_THREADS:-2}"

# Cold compiles peak ~2.4GB (was ~7GB before the Tailwind source-detection
# fix in styles/globals.css). The MM_DEV_BUILD config disables the Turbopack
# FS build cache, so every build here is effectively cold; the warm threshold
# only applies if that setting changes (a large .next/cache then survives
# restarts and rebuilds are cheaper).
COLD_REQUIRED_MB="${COLD_REQUIRED_MB:-3000}"
WARM_REQUIRED_MB="${WARM_REQUIRED_MB:-2200}"
WAIT_TIMEOUT_S="${WAIT_TIMEOUT_S:-180}"
RETRY_INTERVAL_S="${RETRY_INTERVAL_S:-300}"
RETRY_BACKOFF_S="${RETRY_BACKOFF_S:-10}" # pause between initial attempts
MAX_ATTEMPTS=3
LAST_GOOD=".next-last-good"
STATUS_FILE=".next-dev-status"

server_pid=""

avail_mb() {
  awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo
}

cache_is_warm() {
  [ -d .next/cache ] && [ "$(du -sm .next/cache 2>/dev/null | cut -f1)" -ge 50 ]
}

# The IDE's TypeScript language servers hold 1.5-2.5GB combined and respawn
# lazily when the user next edits — safe to kill before a memory-hungry build.
# (The [.] keeps the pattern from matching this script's own cmdline if it is
# ever run with arguments containing the literal text.)
free_ide_memory() {
  pkill -9 -f "typescript/lib/tsserver[.]js" 2>/dev/null
  pkill -9 -f "typescript-language-serve[r]" 2>/dev/null
  return 0
}

wait_for_memory() {
  local required_mb="$1" waited=0 avail freed=0
  avail="$(avail_mb)"
  while [ "$avail" -lt "$required_mb" ] && [ "$waited" -lt "$WAIT_TIMEOUT_S" ]; do
    if [ "$freed" -eq 0 ]; then
      echo "[dev-server] ${avail}MB free (< ${required_mb}MB) — killing idle IDE language servers to make room"
      free_ide_memory
      freed=1
      sleep 3
    else
      echo "[dev-server] ${avail}MB free (< ${required_mb}MB) — waiting for typecheck/tests to finish before building..."
      sleep 5
      waited=$((waited + 5))
    fi
    avail="$(avail_mb)"
  done
}

set_status() {
  printf '%s' "$1" > "$STATUS_FILE"
}

stop_current_server() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null
    wait "$server_pid" 2>/dev/null
    server_pid=""
  fi
}

serve_foreground() {
  # $1 = directory containing the standalone bundle (server.js at its root)
  echo "[dev-server] serving $1/server.js on port 5000"
  stop_current_server
  PORT=5000 HOSTNAME=0.0.0.0 exec node "$1/server.js"
}

serve_something_now() {
  # Open the preview port immediately: last-good bundle if we have one,
  # otherwise the build-status placeholder page.
  if [ -f "$LAST_GOOD/server.js" ]; then
    echo "[dev-server] serving last-good build from $LAST_GOOD while a fresh build runs"
    PORT=5000 HOSTNAME=0.0.0.0 node "$LAST_GOOD/server.js" &
  else
    set_status building
    node scripts/dev-build-placeholder.mjs &
  fi
  server_pid=$!
}

# Assemble the servable standalone bundle and snapshot it as the new
# last-good (OUTSIDE .next, which `next build` wipes on every run).
assemble_and_save() {
  cp -r .next/static .next/standalone/.next/static &&
    cp -r public .next/standalone/public &&
    node scripts/copy-sharp-standalone.mjs || return 1
  rm -rf "$LAST_GOOD"
  cp -a .next/standalone "$LAST_GOOD"
}

build_once() {
  # Returns next build's exit code; retries are only worthwhile for
  # signal-kills (137=SIGKILL/OOM, 139=SIGSEGV, 134=SIGABRT).
  local code=0
  if cache_is_warm; then
    wait_for_memory "$WARM_REQUIRED_MB"
  else
    wait_for_memory "$COLD_REQUIRED_MB"
  fi
  echo "[dev-server] build starting ($(avail_mb)MB free)"
  next build || code=$?
  echo "[dev-server] build exited ${code} ($(avail_mb)MB free)"
  return "$code"
}

retry_worthwhile() {
  case "$1" in 134|137|139) return 0 ;; *) return 1 ;; esac
}

# --- open the preview port FIRST --------------------------------------------
# The workflow marks us FAILED if port 5000 doesn't open within 300s, and a
# cold build takes longer than that. Serve last-good (or a status page) from
# the start; swap in the fresh build when one succeeds.
serve_something_now

# --- initial attempts -------------------------------------------------------
attempt=1
code=0
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  echo "[dev-server] build attempt ${attempt}/${MAX_ATTEMPTS}"
  if build_once; then
    code=0
    break
  else
    code=$?
  fi
  if [ "$attempt" -lt "$MAX_ATTEMPTS" ] && retry_worthwhile "$code"; then
    if [ "$attempt" -eq $((MAX_ATTEMPTS - 1)) ]; then
      # Final attempt: build clean in case the killed run truncated the cache.
      rm -rf .next/cache
    fi
    sleep "$RETRY_BACKOFF_S"
  else
    break
  fi
  attempt=$((attempt + 1))
done

if [ "$code" -eq 0 ]; then
  if assemble_and_save; then
    serve_foreground .next/standalone
  fi
  echo "[dev-server] build succeeded but standalone assembly failed" >&2
  exit 1
fi

# --- all initial attempts failed --------------------------------------------
if retry_worthwhile "$code"; then
  echo "[dev-server] WARNING: build OOM-killed ${MAX_ATTEMPTS}x; retrying every ${RETRY_INTERVAL_S}s until one fits" >&2
  set_status failed
  while true; do
    sleep "$RETRY_INTERVAL_S"
    free_ide_memory
    if build_once; then
      if assemble_and_save; then
        echo "[dev-server] background build succeeded — swapping in the fresh build"
        serve_foreground .next/standalone
      fi
    else
      code=$?
      # A REAL compile error after OOM kills is not a memory problem: stop the
      # retry loop and flip the status page to "broken" instead of rebuilding
      # (and re-killing the IDE language servers) forever.
      retry_worthwhile "$code" || break
    fi
  done
fi

if retry_worthwhile "$code"; then
  # Unreachable safety net: the loop above only exits on success
  # (serve_foreground never returns) or a non-retryable failure.
  echo "[dev-server] unexpected supervisor state; keeping the preview port alive" >&2
else
  echo "[dev-server] next build failed with exit ${code} (not a memory kill) — needs a code fix" >&2
  set_status broken
fi
if [ -n "$server_pid" ]; then
  wait "$server_pid"
fi
