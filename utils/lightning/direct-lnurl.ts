import { LightningAddress, Invoice } from "@getalby/lightning-tools";

// Direct seller-LNURL checkout: when the seller's profile carries a lud16,
// the buyer pays an invoice fetched straight from the seller's lightning
// address (full amount, no mint quote, no donation splits). Every failure
// here returns null so callers fall back to the existing mint flow and the
// buyer can always complete checkout.

// zeuspay addresses use hold-invoice semantics that break both melt and
// verify polling — same exclusion the melt path has always applied.
export const isDirectLightningCandidate = (
  lud16?: string | null
): lud16 is string => {
  const addr = lud16?.trim() || "";
  return (
    addr !== "" &&
    addr.includes("@") &&
    !addr.toLowerCase().includes("@zeuspay.com")
  );
};

export type DirectLightningInvoice = {
  lnurl: string;
  invoice: Invoice;
};

export type PaymentPreference = "lightning" | "ecash" | "fiat";

// The payment preference is derived, never chosen manually: Bitcoin turned
// off in the shop's storefront settings → fiat; a usable lightning address
// → lightning (payments go straight to it); otherwise → ecash (Cashu).
// Settings forms display this read-only and save the derived value so the
// stored preference always matches what checkout will actually do.
export const derivePaymentPreference = (
  lud16?: string | null,
  acceptBitcoin: boolean = true
): PaymentPreference => {
  if (!acceptBitcoin) return "fiat";
  return isDirectLightningCandidate(lud16) ? "lightning" : "ecash";
};

// Fetch an invoice for the full amount from the seller's LNURL.
// `requireVerify` (default true) demands LUD-21 verify support on the
// returned invoice — the only way to confirm an external-wallet payment
// client-side. Callers that receive a preimage themselves (NWC) pass false.
export const requestDirectLightningInvoice = async (
  lud16: string,
  amountSat: number,
  opts?: { requireVerify?: boolean }
): Promise<DirectLightningInvoice | null> => {
  try {
    if (!isDirectLightningCandidate(lud16)) return null;
    if (!Number.isFinite(amountSat) || amountSat < 1) return null;
    const lnurl = lud16.trim();
    const ln = new LightningAddress(lnurl);
    await ln.fetch();
    const payData = ln.lnurlpData;
    if (!payData) return null;
    // min/max are millisats; reject out-of-bounds before the callback 500s.
    const msat = amountSat * 1000;
    if (msat < payData.min || msat > payData.max) return null;
    const invoice = await ln.requestInvoice({ satoshi: amountSat });
    if (!invoice?.paymentRequest) return null;
    if (opts?.requireVerify !== false && !invoice.verify) return null;
    return { lnurl, invoice };
  } catch (err) {
    console.warn(
      "Direct LNURL invoice fetch failed; falling back to mint flow:",
      err
    );
    return null;
  }
};
