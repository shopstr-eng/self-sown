import Stripe from "stripe";

import { getSellerShippingOrigin } from "@/utils/db/db-service";

// Tap to Pay dead-ends with "no Stripe Terminal location found on your
// account" until a Terminal location exists on the seller's CONNECTED
// account — and Express accounts expose no Terminal dashboard, so sellers
// cannot create one themselves. The platform ensures one here, at the
// connection-token choke point (the first Tap to Pay attempt), reusing any
// existing location and memoizing per account so repeat taps add no Stripe
// latency.

export type EnsureTerminalLocationResult =
  | { ok: true; locationId: string; created: boolean }
  | { ok: false; code: "no_address" | "stripe_error"; error: string };

// In-flight + resolved promises per connected account: concurrent taps share
// one Stripe list/create (no duplicate locations), and a resolved success is
// served from memory. Failures are evicted so the next tap retries.
const locationByAccount = new Map<
  string,
  Promise<EnsureTerminalLocationResult>
>();

type TerminalAddress = {
  line1: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
};

// Stripe rejects partial location addresses — require every field.
function toTerminalAddress(source: {
  line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}): TerminalAddress | null {
  const address: TerminalAddress = {
    line1: source.line1?.trim() ?? "",
    city: source.city?.trim() ?? "",
    state: source.state?.trim() ?? "",
    postal_code: source.postal_code?.trim() ?? "",
    country: source.country?.trim() ?? "",
  };
  if (Object.values(address).some((value) => !value)) return null;
  return address;
}

async function resolveAddress(
  stripe: Stripe,
  accountId: string,
  sellerPubkey: string
): Promise<{ address: TerminalAddress; displayName: string } | null> {
  // Preferred: the connected account's verified company/individual address.
  const account = await stripe.accounts.retrieve(accountId);
  const companyAddress = toTerminalAddress(account.company?.address ?? {});
  if (companyAddress) {
    return {
      address: companyAddress,
      displayName: account.company?.name || "Tap to Pay",
    };
  }
  const individualAddress = toTerminalAddress(
    account.individual?.address ?? {}
  );
  if (individualAddress) {
    const name = [account.individual?.first_name, account.individual?.last_name]
      .filter(Boolean)
      .join(" ");
    return { address: individualAddress, displayName: name || "Tap to Pay" };
  }

  // Fallback: the seller's shipping origin from the mobile Shipping tab.
  const origin = await getSellerShippingOrigin(sellerPubkey);
  if (origin) {
    const originAddress = toTerminalAddress({
      line1: origin.from_street1,
      city: origin.from_city,
      state: origin.from_state,
      postal_code: origin.from_zip,
      country: origin.from_country,
    });
    if (originAddress) {
      return {
        address: originAddress,
        displayName: origin.from_company || origin.from_name || "Tap to Pay",
      };
    }
  }
  return null;
}

async function doEnsureTerminalLocation(
  stripe: Stripe,
  accountId: string,
  sellerPubkey: string
): Promise<EnsureTerminalLocationResult> {
  try {
    const existing = await stripe.terminal.locations.list(
      { limit: 1 },
      { stripeAccount: accountId }
    );
    const existingLocation = existing.data[0];
    if (existingLocation) {
      return { ok: true, locationId: existingLocation.id, created: false };
    }

    const resolved = await resolveAddress(stripe, accountId, sellerPubkey);
    if (!resolved) {
      return {
        ok: false,
        code: "no_address",
        // This route only serves the mobile PoS, where the address form lives
        // on the Shipping tab — "Settings → Shipping" is the web route and
        // doesn't exist in the app's navigation.
        error:
          "Add your business address (finish Stripe onboarding, or enter it on the Shipping tab) to enable Tap to Pay.",
      };
    }

    const location = await stripe.terminal.locations.create(
      { display_name: resolved.displayName, address: resolved.address },
      { stripeAccount: accountId }
    );
    return { ok: true, locationId: location.id, created: true };
  } catch (error) {
    console.error(
      `Failed to ensure Terminal location for ${accountId}:`,
      error
    );
    return {
      ok: false,
      code: "stripe_error",
      error: "Could not set up the card reader location",
    };
  }
}

export function ensureTerminalLocation(
  stripe: Stripe,
  accountId: string,
  sellerPubkey: string
): Promise<EnsureTerminalLocationResult> {
  const cached = locationByAccount.get(accountId);
  if (cached) return cached;
  const promise = doEnsureTerminalLocation(stripe, accountId, sellerPubkey);
  locationByAccount.set(accountId, promise);
  // The promise never rejects (doEnsureTerminalLocation catches everything);
  // evict only failures so a later tap retries.
  void promise.then((result) => {
    if (!result.ok) locationByAccount.delete(accountId);
  });
  return promise;
}

// Test-only: reset the memo between cases.
export function resetTerminalLocationCacheForTests(): void {
  locationByAccount.clear();
}
