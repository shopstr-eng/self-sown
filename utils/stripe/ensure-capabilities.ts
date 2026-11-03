import Stripe from "stripe";

// Core capabilities every seller needs. Tap to Pay is deliberately NOT in
// this list: it is a gated platform feature (the platform must be enrolled
// in Tap to Pay for Terminal, and the account's country must support it), so
// Stripe rejects the parameter wholesale when it isn't applicable — and a
// single accounts.update carrying it would silently drop the core
// capabilities with it (production incident: card_payments/transfers stayed
// un-requested because tap_to_pay_payments 400'd the shared call).
const CORE_CAPABILITIES: Array<"card_payments" | "transfers"> = [
  "card_payments",
  "transfers",
];
const TAP_TO_PAY_CAPABILITY = "tap_to_pay_payments";

export type EnsureCapabilitiesResult =
  | {
      ok: true;
      requested: string[];
      alreadySatisfied: boolean;
      // Set when the Tap to Pay request was attempted but rejected (platform
      // not enrolled, unsupported country). Never fatal to the result.
      tapToPayError?: string;
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
    const tapToPayMissing = !isSatisfied(TAP_TO_PAY_CAPABILITY);

    const requested: string[] = [];
    let tapToPayError: string | undefined;

    if (missingCore.length > 0) {
      const capabilitiesUpdate: Record<string, { requested: boolean }> = {};
      for (const cap of missingCore) {
        capabilitiesUpdate[cap] = { requested: true };
      }
      await stripe.accounts.update(accountId, {
        capabilities:
          capabilitiesUpdate as unknown as Stripe.AccountUpdateParams.Capabilities,
      });
      requested.push(...missingCore);
    }

    if (tapToPayMissing) {
      try {
        // stripe-node's Capabilities type lags the API — tap_to_pay_payments
        // is a valid capability but untyped in this SDK version — so build
        // the update as a plain record and trust the wire contract.
        await stripe.accounts.update(accountId, {
          capabilities: {
            [TAP_TO_PAY_CAPABILITY]: { requested: true },
          } as unknown as Stripe.AccountUpdateParams.Capabilities,
        });
        requested.push(TAP_TO_PAY_CAPABILITY);
      } catch (err) {
        // Best-effort: gated on platform Tap to Pay enrollment and country
        // support. Sellers keep working — the PoS card screen just won't
        // offer Tap to Pay until the platform is enrolled and this is retried
        // (every account-link/manage-link call re-runs this seam).
        tapToPayError = err instanceof Error ? err.message : String(err);
        console.warn(
          `Tap to Pay capability request rejected for ${accountId}:`,
          tapToPayError
        );
      }
    }

    const alreadySatisfied = missingCore.length === 0 && !tapToPayMissing;
    return {
      ok: true,
      requested,
      alreadySatisfied,
      ...(tapToPayError ? { tapToPayError } : {}),
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
