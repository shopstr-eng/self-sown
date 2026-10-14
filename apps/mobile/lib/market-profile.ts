import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PaymentPreference, SellerSession } from "@self-sown/domain";
import {
  derivePaymentPreference,
  resolveDonationValue,
  stripLegacyDonationKeys,
} from "@self-sown/domain";
import { publishSellerProfile } from "@self-sown/nostr";

import { getApiBaseUrl } from "./api-base-url";

// Mobile port of components/settings/market-profile-form.tsx. The web form
// hydrates from the DB-cached kind:0 event and keeps a per-pubkey localStorage
// fallback that wins when newer than the relay/DB copy; this lib mirrors that
// with AsyncStorage. The fallback is written ONLY after a confirmed publish
// (see the profile local-fallback ordering rule) so a rejected publish never
// leaves phantom local state the form would later hydrate from.
const MARKET_PROFILE_FALLBACK_PREFIX = "self-sown:user-profile:";

export const FIAT_OPTION_FIELDS: ReadonlyArray<{
  key: string;
  label: string;
  requiresUsername: boolean;
}> = [
  { key: "cash", label: "Cash", requiresUsername: false },
  { key: "venmo", label: "Venmo", requiresUsername: true },
  { key: "zelle", label: "Zelle", requiresUsername: true },
  { key: "cashapp", label: "Cash App", requiresUsername: true },
  { key: "applepay", label: "Apple Pay", requiresUsername: true },
  { key: "googlepay", label: "Google Pay", requiresUsername: true },
  { key: "paypal", label: "PayPal", requiresUsername: true },
];

export type MarketProfileDraft = {
  picture: string;
  displayName: string;
  username: string;
  nip05: string;
  lud16: string;
  donationPercent: string;
  fiatOptions: Record<string, string>;
};

export type MarketProfileValidationErrors = Partial<{
  donationPercent: string;
}>;

type MarketProfileContent = Record<string, unknown>;

export type { PaymentPreference } from "@self-sown/domain";

export function createEmptyMarketProfileDraft(): MarketProfileDraft {
  return {
    picture: "",
    displayName: "",
    username: "",
    nip05: "",
    lud16: "",
    donationPercent: "0",
    fiatOptions: {},
  };
}

// Pre-rebrand profiles store the donation rate under mm_donation (or the even
// older shopstr_donation); ss_donation is the canonical key. Read precedence
// comes from the shared domain helper so web and mobile never drift.
function readDonationPercent(content: MarketProfileContent): string {
  const raw = resolveDonationValue(content);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return "0";
  }
  return String(raw);
}

export function createMarketProfileDraft(
  content: MarketProfileContent | null | undefined
): MarketProfileDraft {
  if (!content) {
    return createEmptyMarketProfileDraft();
  }

  const fiatOptions: Record<string, string> = {};
  const rawFiatOptions = content.fiat_options;
  if (
    rawFiatOptions &&
    typeof rawFiatOptions === "object" &&
    !Array.isArray(rawFiatOptions)
  ) {
    for (const [key, value] of Object.entries(
      rawFiatOptions as Record<string, unknown>
    )) {
      if (FIAT_OPTION_FIELDS.some((field) => field.key === key)) {
        fiatOptions[key] = typeof value === "string" ? value : "available";
      }
    }
  }

  return {
    picture: typeof content.picture === "string" ? content.picture : "",
    displayName:
      typeof content.display_name === "string" ? content.display_name : "",
    username: typeof content.name === "string" ? content.name : "",
    nip05: typeof content.nip05 === "string" ? content.nip05 : "",
    lud16: typeof content.lud16 === "string" ? content.lud16 : "",
    donationPercent: readDonationPercent(content),
    fiatOptions,
  };
}

// The payment preference is derived, never chosen manually. The rules
// (Bitcoin off → fiat; usable lightning address → lightning; otherwise →
// ecash, with zeuspay hold-invoice addresses excluded) live in
// packages/domain so web and mobile publish identical values.
export const deriveMarketPaymentPreference = derivePaymentPreference;

export function describeMarketPaymentPreference(
  preference: PaymentPreference
): string {
  if (preference === "lightning") return "Lightning (Bitcoin)";
  if (preference === "fiat") return "Local Currency (Fiat)";
  return "Cashu (Bitcoin)";
}

export function validateMarketProfileDraft(
  draft: MarketProfileDraft
): MarketProfileValidationErrors {
  const errors: MarketProfileValidationErrors = {};
  const rawDonation = draft.donationPercent.trim();
  // Blank means "no donation" (0), matching the web number input clearing to
  // empty. Anything else must be a real 0-100 number — never let Number("")
  // or Number("abc") coerce silently.
  if (rawDonation !== "") {
    const parsed = Number(rawDonation);
    if (!Number.isFinite(parsed)) {
      errors.donationPercent = "Enter a donation between 0 and 100.";
    } else if (parsed < 0 || parsed > 100) {
      errors.donationPercent = "Donation must be between 0 and 100.";
    }
  }
  return errors;
}

export function buildMarketProfileContent(
  existingContent: MarketProfileContent | null | undefined,
  draft: MarketProfileDraft,
  acceptBitcoin: boolean
): MarketProfileContent {
  const donation = draft.donationPercent.trim();
  const content: MarketProfileContent = {
    ...(existingContent ?? {}),
    picture: draft.picture.trim(),
    display_name: draft.displayName.trim(),
    name: draft.username.trim(),
    nip05: draft.nip05.trim(),
    lud16: draft.lud16.trim(),
    ss_donation: donation === "" ? 0 : Number(donation),
    fiat_options: draft.fiatOptions,
    payment_preference: deriveMarketPaymentPreference(
      draft.lud16,
      acceptBitcoin
    ),
  };
  // Drop legacy donation fields; ss_donation is canonical.
  stripLegacyDonationKeys(content);
  return content;
}

export async function fetchMarketProfile(pubkey: string): Promise<{
  content: MarketProfileContent;
  createdAt: number;
} | null> {
  const response = await fetch(
    `${getApiBaseUrl()}/api/db/fetch-profile?pubkey=${encodeURIComponent(
      pubkey
    )}`
  );
  if (!response.ok) {
    throw new Error("Profile could not be loaded.");
  }
  const body = (await response.json()) as {
    profile?: { content?: unknown; created_at?: number } | null;
  };
  if (
    !body.profile ||
    !body.profile.content ||
    typeof body.profile.content !== "object"
  ) {
    return null;
  }
  return {
    content: body.profile.content as MarketProfileContent,
    createdAt:
      typeof body.profile.created_at === "number" ? body.profile.created_at : 0,
  };
}

type MarketProfileFallback = {
  content: MarketProfileContent;
  updatedAt: number;
};

function isPopulatedFallback(
  fallback: MarketProfileFallback | null
): fallback is MarketProfileFallback {
  if (!fallback) return false;
  return Object.values(fallback.content).some((value) => {
    if (typeof value === "string") return value.trim() !== "";
    if (typeof value === "number") return value !== 0;
    if (value && typeof value === "object")
      return Object.keys(value).length > 0;
    return Boolean(value);
  });
}

export async function readMarketProfileFallback(
  pubkey: string
): Promise<MarketProfileFallback | null> {
  try {
    const raw = await AsyncStorage.getItem(
      `${MARKET_PROFILE_FALLBACK_PREFIX}${pubkey}`
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MarketProfileFallback>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.content ||
      typeof parsed.content !== "object" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    return {
      content: parsed.content as MarketProfileContent,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

// Returns whichever source is newer: the locally persisted fallback (written
// after a confirmed publish) or the DB-cached relay copy.
export async function resolveMarketProfile(pubkey: string): Promise<{
  content: MarketProfileContent;
  updatedAt: number;
} | null> {
  const [remote, fallback] = await Promise.all([
    fetchMarketProfile(pubkey),
    readMarketProfileFallback(pubkey),
  ]);

  if (
    fallback &&
    isPopulatedFallback(fallback) &&
    fallback.updatedAt > (remote?.createdAt ?? 0)
  ) {
    return { content: fallback.content, updatedAt: fallback.updatedAt };
  }
  if (remote) {
    return { content: remote.content, updatedAt: remote.createdAt };
  }
  if (fallback && isPopulatedFallback(fallback)) {
    return { content: fallback.content, updatedAt: fallback.updatedAt };
  }
  return null;
}

export async function saveMarketProfile(
  session: SellerSession,
  existingContent: MarketProfileContent | null | undefined,
  draft: MarketProfileDraft,
  acceptBitcoin: boolean
): Promise<void> {
  const content = buildMarketProfileContent(
    existingContent,
    draft,
    acceptBitcoin
  );
  // Publish FIRST; the local fallback is persisted only after the publish
  // resolves so a failed publish never leaves a newer local copy behind.
  await publishSellerProfile({
    baseUrl: getApiBaseUrl(),
    session,
    content: JSON.stringify(content),
  });

  try {
    await AsyncStorage.setItem(
      `${MARKET_PROFILE_FALLBACK_PREFIX}${session.pubkey}`,
      JSON.stringify({
        content,
        updatedAt: Math.floor(Date.now() / 1000),
      })
    );
  } catch {
    // Local fallback persistence is best-effort; the publish already succeeded.
  }
}
