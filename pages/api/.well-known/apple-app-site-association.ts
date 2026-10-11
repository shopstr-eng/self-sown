import { NextApiRequest, NextApiResponse } from "next";
import { getSiteHost } from "@/utils/site-url";
import { isSelfHost } from "@/utils/self-host/config";

// iOS universal-links association for the Self-sown seller app. Lets the
// account-recovery email link (/auth/recover?token=...) open directly in the
// installed app; devices without the app fall through to the web page at the
// same URL. Apple only fetches this file from domains listed in the app's
// entitlements (applinks:<platform host>), so it is served on the platform
// host only and 404s everywhere else (seller custom domains, self-host) —
// claiming app association for a seller's domain would be wrong.
//
// Team ID + bundle IDs are public identifiers (the same values ship in the
// app's entitlements and the App Store listing), so they live as constants,
// not env vars.
const TEAM_ID = "JD83N884V6";
const APP_IDS = [
  `${TEAM_ID}.com.selfsown.mobile`,
  `${TEAM_ID}.com.selfsown.mobile.staging`,
];

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
  return res.status(200).json({
    applinks: {
      details: [
        {
          appIDs: APP_IDS,
          components: [
            {
              "/": "/auth/recover",
              comment: "Seller account-recovery email link",
            },
          ],
        },
      ],
    },
  });
}
