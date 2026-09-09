#!/usr/bin/env bash
# Measure the peak memory of a cold `next build` in this container.
#
# Usage: bash scripts/measure-build-peak.sh [--keep-cache] [-- extra build args]
#
# Removes .next (unless --keep-cache), then runs the dev-workflow build
# (MM_DEV_BUILD=1) under setsid while sampling the RSS of every build-related
# process every 0.5s. Writes:
#   .build-measure/build.log        — full build output
#   .build-measure/rss-samples.tsv  — epoch_ms<TAB>total_rss_mb<TAB>per-proc breakdown
#   .build-measure/summary.txt      — peak MB, exit code, wall time
set -uo pipefail

KEEP_CACHE=0
EXTRA_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-cache) KEEP_CACHE=1; shift ;;
    --) shift; EXTRA_ARGS=("$@"); break ;;
    *) EXTRA_ARGS+=("$1"); shift ;;
  esac
done

OUT=.build-measure
mkdir -p "$OUT"
: > "$OUT/rss-samples.tsv"

if [ "$KEEP_CACHE" -eq 0 ]; then
  rm -rf .next
fi

export MM_DEV_BUILD=1
export NODE_OPTIONS='--max-old-space-size=3072'
export RAYON_NUM_THREADS="${RAYON_NUM_THREADS:-2}"

# Match the dev-server.sh supervisor's pre-build hygiene: the IDE's TypeScript
# language servers hold 1.5-2.5GB combined and respawn lazily when the user
# next edits, so killing them is safe and keeps measurements uncontended.
pkill -9 -f "typescript/lib/tsserver[.]js" 2>/dev/null
pkill -9 -f "typescript-language-serve[r]" 2>/dev/null
sleep 2
echo "[measure] pre-build available: $(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)MB"

start_ts=$(date +%s)
setsid npx next build --experimental-debug-memory-usage "${EXTRA_ARGS[@]}" \
  > "$OUT/build.log" 2>&1 &
build_pid=$!

# Sampler: sum RSS (KB) of all processes belonging to the build session plus
# any next/turbopack/postcss/jest-worker children.
peak=0
while kill -0 "$build_pid" 2>/dev/null; do
  sample=$(ps -eo rss,args | awk '
    /[n]ext-build|[n]ext build|[n]ext-server|[t]urbopack|[p]ostcss|[j]est-worker/ { s+=$1 }
    END { print int(s/1024) }')
  ts=$(date +%s%3N)
  echo -e "${ts}\t${sample}" >> "$OUT/rss-samples.tsv"
  if [ "${sample:-0}" -gt "$peak" ]; then peak=$sample; fi
  sleep 0.5
done
wait "$build_pid"
code=$?
end_ts=$(date +%s)

{
  echo "exit_code=$code"
  echo "peak_rss_mb=$peak"
  echo "wall_s=$((end_ts - start_ts))"
  echo "args=${EXTRA_ARGS[*]:-<none>}"
  echo "mm_dev_build=$MM_DEV_BUILD rayon=$RAYON_NUM_THREADS keep_cache=$KEEP_CACHE"
  date -u +"measured_at=%Y-%m-%dT%H:%M:%SZ"
} | tee "$OUT/summary.txt"

# Preserve per-run artifacts so experiments can be compared afterwards.
stamp=$(date -u +%H%M%S)
cp "$OUT/build.log" "$OUT/build-$stamp.log"
cp "$OUT/summary.txt" "$OUT/summary-$stamp.txt"
exit "$code"
