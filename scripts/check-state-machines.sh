#!/usr/bin/env bash
# Supply the official tla2tools.jar; never download or execute an unpinned jar.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${TLA2TOOLS_JAR:?Set TLA2TOOLS_JAR to an official, verified tla2tools.jar}"
jar="$(realpath "$TLA2TOOLS_JAR")"
test -f "$jar" || { echo "TLA+ tools jar not found: $jar" >&2; exit 1; }
command -v java >/dev/null || { echo "Java 11+ is required" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$root"/formal/state-machines/*.{tla,cfg} "$work/"
cd "$work"

for model in UcpCheckout CashuEscrowOutbox SellerOrder CustomDomain \
             ScheduledBlog ProMembership MobilePushDelivery; do
  echo "=== $model ==="
  if ! java -Xmx768m -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
       -config "$model.cfg" "$model.tla" >"$model.log" 2>&1; then
    cat "$model.log"
    exit 1
  fi
  grep -E 'Model checking completed|states generated|depth of the complete' "$model.log"
done

# Preserve a known counterexample rather than silently strengthening the model
# to hide the completion/retry interaction present in today's route handlers.
echo "=== UCP completion/retry diagnostic (counterexample expected) ==="
set +e
java -Xmx768m -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
  -config UcpCheckoutRetryRace.cfg UcpCheckout.tla >race.log 2>&1
result=$?
set -e
if [[ "$result" -eq 0 ]] || ! grep -q \
  'Invariant ClaimRemainsSettleable is violated' race.log; then
  cat race.log
  echo "Expected completion/retry counterexample was not reproduced" >&2
  exit 1
fi
cat race.log

echo "=== Escrow expiry/recovery diagnostic (counterexample expected) ==="
set +e
java -Xmx768m -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
  -config CashuEscrowExpiryRecovery.cfg CashuEscrowOutbox.tla >expiry.log 2>&1
result=$?
set -e
if [[ "$result" -eq 0 ]] || ! grep -q \
  'Invariant PreparedBeforeMint is violated' expiry.log; then
  cat expiry.log
  echo "Expected escrow recovery counterexample was not reproduced" >&2
  exit 1
fi
cat expiry.log
