import { LightningAddress, Invoice } from "@getalby/lightning-tools";
import { isDirectLightningCandidate } from "@self-sown/domain";

// Direct seller-LNURL checkout: when the seller's profile carries a lud16,
// the buyer pays an invoice fetched straight from the seller's lightning
// address (full amount, no mint quote, no donation splits). Every failure
// here returns null so callers fall back to the existing mint flow and the
// buyer can always complete checkout.

// The candidate check and the payment-preference derivation live in
// packages/domain so web and mobile share one implementation; they are
// re-exported here so existing web imports keep working.
export {
  isDirectLightningCandidate,
  derivePaymentPreference,
} from "@self-sown/domain";
export type { PaymentPreference } from "@self-sown/domain";

export type DirectLightningInvoice = {
  lnurl: string;
  invoice: Invoice;
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
