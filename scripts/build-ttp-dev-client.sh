#!/usr/bin/env bash
# Build the iOS development client with the Tap to Pay entitlement.
#
# Apple's Tap to Pay grant is development-restricted: the proximity-reader
# entitlement is ONLY embedded in IOS_APP_DEVELOPMENT provisioning profiles.
# Ad-hoc (internal distribution) and App Store profiles silently drop it, and
# fastlane then fails with "Entitlement com.apple.developer.proximity-reader...
# not found and could not be included in profile."
#
# So this script temporarily points credentials.json at the development
# certificate + profile in apps/mobile/keys (created via the ASC API), runs
# the EAS build, and restores the production credentials afterward.
#
# Files it relies on (all gitignored):
#   keys/dev-profile.mobileprovision  — IOS_APP_DEVELOPMENT profile, includes
#                                       the proximity-reader entitlement and
#                                       the registered device UDIDs
#   keys/dev-cert.p12                 — iOS Development certificate (with key)
#   keys/dev-cert.p12.pass            — password for the p12
# To add another device: eas device:create, then regenerate the profile via
# the ASC API including the new device UDID (see .agents/memory/eas-mobile-release.md).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOBILE="$ROOT/apps/mobile"
CREDS="$MOBILE/credentials.json"
BACKUP="$(mktemp)"

cp "$CREDS" "$BACKUP"
restore() { cp "$BACKUP" "$CREDS"; rm -f "$BACKUP"; }
trap restore EXIT

PASS="$(cat "$MOBILE/keys/dev-cert.p12.pass")"
cat > "$CREDS" <<EOF
{
  "ios": {
    "SelfsownVendor": {
      "provisioningProfilePath": "keys/dev-profile.mobileprovision",
      "distributionCertificate": {
        "path": "keys/dev-cert.p12",
        "password": "$PASS"
      }
    }
  }
}
EOF

cd "$MOBILE"
# EXPO_NO_CAPABILITY_SYNC: the ASC API rejects TAP_TO_PAY_ON_IPHONE as a
# capabilityType (the enum doesn't include it); the capability is enabled
# manually in the Developer portal instead.
EXPO_NO_CAPABILITY_SYNC=1 eas build --platform ios --profile development "$@"
