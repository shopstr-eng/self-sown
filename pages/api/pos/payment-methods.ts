import type { NextApiRequest, NextApiResponse } from "next";

import { getStripeConnectAccount } from "@/utils/db/db-service";
import { getSquareConnection } from "@/utils/db/square-service";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { applyRateLimit } from "@/utils/rate-limit";
import { isSquareConfigured } from "@/utils/square/square-config";
import { getSelfHostConfig } from "@/utils/self-host/config";

// Mobile PoS capability discovery: which card rails the authenticated seller
// can actually collect on. Lightning (NWC) is device-local and never reported
// here. Card processors are Connect-only — on a self-host tenant the owner's
// own Stripe key serves the web storefront, not per-seller Terminal readers,
// so PoS card rails fail closed there.
const RATE_LIMIT = { limit: 120, windowMs: 60_000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Cache-Control", "private, no-store");
  if (!(await applyRateLimit(req, res, "pos-payment-methods", RATE_LIMIT))) {
    return;
  }

  const authResult = await verifyNip98Request(req, "POST", req.body);
  if (!authResult.ok) {
    return res.status(401).json({ error: authResult.error });
  }

  const selfHost = getSelfHostConfig();
  if (selfHost.enabled) {
    return res.status(200).json({
      stripe: { connected: false, chargesEnabled: false },
      square: { connected: false },
    });
  }

  let stripeConnected = false;
  let stripeChargesEnabled = false;
  let squareConnected = false;
  try {
    const [stripeAccount, squareConnection] = await Promise.all([
      getStripeConnectAccount(authResult.pubkey).catch(() => null),
      isSquareConfigured()
        ? getSquareConnection(authResult.pubkey).catch(() => null)
        : Promise.resolve(null),
    ]);
    stripeConnected = Boolean(stripeAccount);
    stripeChargesEnabled = Boolean(
      stripeAccount?.charges_enabled && stripeAccount?.onboarding_complete
    );
    squareConnected = squareConnection?.status === "connected";
  } catch {
    // Fail closed per-rail above; an outage just hides the card buttons.
  }

  return res.status(200).json({
    stripe: {
      connected: stripeConnected,
      chargesEnabled: stripeChargesEnabled,
    },
    square: { connected: squareConnected },
  });
}
