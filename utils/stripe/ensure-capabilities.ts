import Stripe from "stripe";

const REQUIRED_CAPABILITIES: Array<
  "card_payments" | "transfers" | "tap_to_pay_payments"
> = [
  "card_payments",
  "transfers",
  // Tap to Pay on iPhone/Android (Stripe Terminal). Requested best-effort:
  // Stripe rejects the request in countries where Tap to Pay isn't available,
  // and callers treat an ensure failure as non-fatal so unsupported sellers
  // keep working — the PoS card screen just won't offer Tap to Pay there.
  "tap_to_pay_payments",
];

export type EnsureCapabilitiesResult =
  | { ok: true; requested: string[]; alreadySatisfied: boolean }
  | { ok: false; error: string };

export async function ensureConnectAccountCapabilities(
  stripe: Stripe,
  accountId: string
): Promise<EnsureCapabilitiesResult> {
  try {
    const account = await stripe.accounts.retrieve(accountId);
    if (account.type !== "express" && account.type !== "standard") {
      return { ok: true, requested: [], alreadySatisfied: true };
    }

    const current = (account.capabilities || {}) as Record<string, string>;
    const missing = REQUIRED_CAPABILITIES.filter(
      (cap) => current[cap] !== "active" && current[cap] !== "pending"
    );

    if (missing.length === 0) {
      return { ok: true, requested: [], alreadySatisfied: true };
    }

    // stripe-node's Capabilities type lags the API — tap_to_pay_payments is
    // a valid capability but untyped in this SDK version — so build the
    // update as a plain record and trust the wire contract.
    const capabilitiesUpdate: Record<string, { requested: boolean }> = {};
    for (const cap of missing) {
      capabilitiesUpdate[cap] = { requested: true };
    }

    await stripe.accounts.update(accountId, {
      capabilities:
        capabilitiesUpdate as unknown as Stripe.AccountUpdateParams.Capabilities,
    });

    return { ok: true, requested: missing, alreadySatisfied: false };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(
      `Failed to ensure Stripe capabilities for ${accountId}:`,
      error
    );
    return { ok: false, error };
  }
}
