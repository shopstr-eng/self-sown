import Stripe from "stripe";

// Core capabilities every seller needs. Tap to Pay needs NO capability of
// its own: it rides on card_payments. Verified live (a contactless Tap to
// Pay charge succeeded on an account whose only relevant capability is
// card_payments) and confirmed by Stripe support: tap_to_pay_payments does
// not exist as a requestable capability, and asking for it 400s with
// "Received unknown parameter". (Production incident: that 400 used to sink
// the shared accounts.update call, leaving card_payments/transfers
// un-requested.)
const CORE_CAPABILITIES: Array<"card_payments" | "transfers"> = [
  "card_payments",
  "transfers",
];

export type EnsureCapabilitiesResult =
  | {
      ok: true;
      requested: string[];
      alreadySatisfied: boolean;
    }
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
    const isSatisfied = (cap: string) =>
      current[cap] === "active" || current[cap] === "pending";
    const missingCore = CORE_CAPABILITIES.filter((cap) => !isSatisfied(cap));

    if (missingCore.length > 0) {
      const capabilitiesUpdate: Record<string, { requested: boolean }> = {};
      for (const cap of missingCore) {
        capabilitiesUpdate[cap] = { requested: true };
      }
      await stripe.accounts.update(accountId, {
        capabilities:
          capabilitiesUpdate as unknown as Stripe.AccountUpdateParams.Capabilities,
      });
    }

    return {
      ok: true,
      requested: missingCore,
      alreadySatisfied: missingCore.length === 0,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(
      `Failed to ensure Stripe capabilities for ${accountId}:`,
      error
    );
    return { ok: false, error };
  }
}
