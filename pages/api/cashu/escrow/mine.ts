// GET /api/cashu/escrow/mine  (NIP-98 authenticated)
//
// Buyer-authenticated escrow rediscovery. A buyer who wiped their browser
// loses the local `cashu_escrows` records — and with them the escrowIds that
// are the ONLY handle to a completed refund payout (the status endpoint is
// bearer-by-id, and the kind-7375 restore correctly refuses to resurrect the
// SPENT locked proofs). The money sits server-side, P2PK-locked to the
// buyer, with no way for them to find it. This endpoint lets the wallet page
// rediscover it.
//
// Deliberately minimal contract: ids + status metadata only. The payout
// proofs themselves are still served by the bearer status endpoint (where
// they are dynamically encoded from the outbox), so this response contains
// nothing sensitive beyond what the authenticated buyer already owns.

import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { isEscrowEnabled } from "@/utils/cashu/escrow-config";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { listEscrowRegistrationsByBuyer } from "@/utils/db/cashu-escrow-service";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Fail closed: escrow is inert until explicitly enabled and configured.
  if (!isEscrowEnabled()) {
    return res.status(403).json({
      error: "Cashu escrow is not enabled on this server.",
      code: "escrow_disabled",
    });
  }

  const allowed = await applyRateLimit(req, res, "cashu-escrow-mine", {
    limit: 10,
    windowMs: 60_000,
  });
  if (!allowed) return;

  const auth = await verifyNip98Request(req, "GET");
  if (!auth.ok) {
    return res
      .status(401)
      .json({ error: auth.error, code: "unauthorized" });
  }

  try {
    const escrows = await listEscrowRegistrationsByBuyer(auth.pubkey);
    return res.status(200).json({
      escrows: escrows.map((e) => ({
        escrowId: e.escrowId,
        orderId: e.orderId,
        sellerPubkey: e.sellerPubkey,
        amountSats: e.amountSats,
        mintUrl: e.mintUrl,
        expiresAt: Math.floor(e.expiresAt.getTime() / 1000),
        createdAt: Math.floor(e.createdAt.getTime() / 1000),
        status: e.status,
        pendingAction: e.pendingAction,
        payoutAvailable: e.payoutAvailable,
      })),
    });
  } catch (error) {
    // A DB outage must NOT masquerade as "no escrows" — the wiped buyer
    // would read that as "nothing to recover". Fail loudly so the client
    // keeps its local view and retries.
    console.error("Cashu escrow rediscovery lookup failed:", error);
    return res.status(500).json({
      error: "Escrow rediscovery lookup failed.",
      code: "internal_error",
    });
  }
}
