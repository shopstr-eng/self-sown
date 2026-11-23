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
             ScheduledBlog ProMembership MobilePushDelivery OAuthHandoff; do
  echo "=== $model ==="
  if ! java -Xmx768m -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
       -config "$model.cfg" "$model.tla" >"$model.log" 2>&1; then
    cat "$model.log"
    exit 1
  fi
  grep -E 'Model checking completed|states generated|depth of the complete' "$model.log"
done

# These regression properties previously produced counterexamples. The source
# now enforces retry ownership and never discards prepared escrow recovery data.
for config in UcpCheckoutRetryRace CashuEscrowExpiryRecovery; do
  case "$config" in
    Ucp*) model=UcpCheckout ;;
    *) model=CashuEscrowOutbox ;;
  esac
  echo "=== $config (regression must pass) ==="
  if ! java -Xmx768m -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
       -config "$config.cfg" "$model.tla" >"$config.log" 2>&1; then
    cat "$config.log"
    exit 1
  fi
  grep -E 'Model checking completed|states generated|depth of the complete' "$config.log"
done
