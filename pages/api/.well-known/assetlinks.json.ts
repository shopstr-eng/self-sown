import { NextApiRequest, NextApiResponse } from "next";
import { getSiteHost } from "@/utils/site-url";
import { isSelfHost } from "@/utils/self-host/config";

// Android App Links association for the Self-sown seller app. Counterpart to
// apple-app-site-association: verifies https://<platform host>/auth/recover
// links so they open directly in the installed app (the intent filter uses
// autoVerify). Served on the platform host only; 404s on seller custom
// domains and self-host instances, which the app never claims.
//
// The fingerprint is the upload-keystore signing cert (keys/android-keystore)
// — public information that Google Play also publishes. NOTE: if Play App
// Signing is enabled for a track, Play re-signs with Google's key and that
// app-signing fingerprint (Play Console → Setup → App integrity) must be
// added here too, or store installs won't verify.
const SHA256_CERT_FINGERPRINTS = [
  "4D:15:39:C3:B0:E9:FB:DD:0D:2A:66:2E:2B:7E:7A:BB:9A:65:D5:F8:1C:F7:16:B3:5C:64:B0:74:34:88:A2:D7",
];

const PACKAGE_NAMES = ["com.selfsown.mobile", "com.selfsown.mobile.staging"];

// Port-, case-, and trailing-dot-insensitive host comparison (same convention
// as the Apple Pay association route).
function normalizeHost(host: string | undefined): string {
  return (host || "").split(":")[0]?.toLowerCase().replace(/\.$/, "") ?? "";
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // Self-host instances set NEXT_PUBLIC_BASE_URL to the operator's own
  // domain, so the host check alone would pass there — but the seller app
  // only ever claims the platform host. 404 explicitly.
  if (isSelfHost()) return res.status(404).end();
  if (normalizeHost(req.headers.host) !== normalizeHost(getSiteHost())) {
    return res.status(404).end();
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.status(200).json(
    PACKAGE_NAMES.map((packageName) => ({
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: SHA256_CERT_FINGERPRINTS,
      },
    }))
  );
}
