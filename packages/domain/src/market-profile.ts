// Shared seller market-profile rules used by BOTH the web app
// (utils/lightning/direct-lnurl.ts, settings forms) and the mobile app
// (apps/mobile/lib/market-profile.ts). Keep this module dependency-free so
// mobile never pulls in heavy web-only packages like
// @getalby/lightning-tools; a change here must be the only change needed to
// keep both apps publishing identical profile content.

export type PaymentPreference = "lightning" | "ecash" | "fiat";

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

// Donation-rate key history: shopstr_donation (oldest) → mm_donation
// (pre-rebrand) → ss_donation (canonical). All reads and writes across web
// and mobile must go through these helpers so the two apps never drift on
// which key wins or which keys are dropped.
export const CANONICAL_DONATION_KEY = "ss_donation";
export const LEGACY_DONATION_KEYS = [
  "mm_donation",
  "shopstr_donation",
] as const;

// Read precedence for the donation rate: canonical key first, then legacy
// keys newest-to-oldest. Returns 0 when nothing is set.
export const resolveDonationValue = (
  content: Record<string, unknown> | null | undefined
): unknown => {
  if (!content) return 0;
  return (
    content[CANONICAL_DONATION_KEY] ??
    content[LEGACY_DONATION_KEYS[0]] ??
    content[LEGACY_DONATION_KEYS[1]] ??
    0
  );
};

// Maps a legacy donation key onto the canonical one when the canonical key
// is absent. Returns the original object untouched when there is nothing to
// migrate, so callers can use reference equality to detect no-ops.
export const migrateLegacyDonationKey = <
  T extends Record<string, unknown> | null | undefined
>(
  content: T
): T => {
  if (!content) return content;
  if (content[CANONICAL_DONATION_KEY] !== undefined) return content;
  const legacy =
    content[LEGACY_DONATION_KEYS[0]] ?? content[LEGACY_DONATION_KEYS[1]];
  if (legacy === undefined) return content;
  return { ...content, [CANONICAL_DONATION_KEY]: legacy };
};

// Drops the legacy donation keys in place; the canonical key is the only
// one ever written back out.
export const stripLegacyDonationKeys = (
  content: Record<string, unknown>
): void => {
  for (const key of LEGACY_DONATION_KEYS) {
    delete content[key];
  }
};
