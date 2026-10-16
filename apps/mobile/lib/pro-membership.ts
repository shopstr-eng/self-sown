import { signEventTemplate } from "@self-sown/nostr";
import type { SellerSession } from "@self-sown/domain";

import { getApiBaseUrl } from "./api-base-url";

// Mirrors the web Pro membership contracts in pages/api/pro/* and
// utils/pro/constants.ts. Status reads use the public /api/pro/status
// endpoint; purchases and the billing portal go through the hosted-checkout
// endpoints, each authorized by a kind-27235 signed proof in the
// x-signed-event header whose tags bind action/method/path/pubkey (+ plan),
// same as the web dashboard (see utils/nostr/request-auth.ts).
const SIGNED_EVENT_HEADER = "x-signed-event";
const SIGNED_HTTP_REQUEST_KIND = 27235;

// Mirrors PRO_MONTHLY_PRICE_CENTS / PRO_ANNUAL_PRICE_CENTS /
// WRANGLER_LIFETIME_PRICE_CENTS in utils/pro/constants.ts.
export const PRO_MONTHLY_PRICE_CENTS = 2100;
export const PRO_ANNUAL_PRICE_CENTS = 16800;
export const WRANGLER_LIFETIME_PRICE_CENTS = 210000;

export type ProCheckoutPlan = "monthly" | "yearly" | "lifetime";

// Client-facing subset of MembershipView (utils/pro/constants.ts) returned by
// GET /api/pro/status.
export interface MobileMembershipView {
  pubkey: string;
  status: "free" | "trialing" | "active" | "grace" | "readonly" | "hidden";
  isPro: boolean;
  isTrialing: boolean;
  isLifetime: boolean;
  billingMethod: "stripe" | "manual" | null;
  term: "monthly" | "yearly" | null;
  trialEnd: string | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  cancelAtPeriodEnd: boolean;
}

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

// Client-facing subset of ProBillingHistoryItem (utils/pro/constants.ts)
// returned by GET /api/pro/history, merged newest-first by the server.
export interface MobileProBillingHistoryItem {
  id: string;
  source: "stripe" | "manual";
  paidAt: string | null;
  amountCents: number;
  currency: string;
  term: "monthly" | "yearly" | null;
  lifetime?: boolean;
  method: "stripe" | "bitcoin" | "fiat";
  coverageStart: string | null;
  coverageEnd: string | null;
  receiptUrl: string | null;
  invoicePdfUrl: string | null;
}

type ProofValue = string | number | null | undefined;

function signProof(
  session: SellerSession,
  action: string,
  method: "GET" | "POST",
  path: string,
  fields: Record<string, ProofValue> = {}
): string {
  const sortedFields = Object.entries(fields)
    .flatMap(([key, value]) => {
      if (value === undefined || value === null || value === "") return [];
      return [[key, String(value)]] as Array<[string, string]>;
    })
    .sort(([left], [right]) => left.localeCompare(right));

  const signedEvent = signEventTemplate(session, {
    kind: SIGNED_HTTP_REQUEST_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ["action", action],
      ["method", method],
      ["path", path],
      ["pubkey", session.pubkey],
      ...sortedFields,
    ],
  });
  return JSON.stringify(signedEvent);
}

async function postSigned(
  session: SellerSession,
  path: string,
  action: string,
  body: Record<string, unknown>,
  proofFields: Record<string, ProofValue> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SIGNED_EVENT_HEADER]: signProof(
        session,
        action,
        "POST",
        path,
        proofFields
      ),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Request failed."));
  }
  return response.json();
}

async function getSigned(
  session: SellerSession,
  path: string,
  action: string,
  proofFields: Record<string, ProofValue> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  // The server compares the signed path tag to a fixed pathname (e.g.
  // buildProHistoryProof's "/api/pro/history"), so the query string must be
  // stripped from the proof even though it stays on the request URL.
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method: "GET",
    headers: {
      [SIGNED_EVENT_HEADER]: signProof(
        session,
        action,
        "GET",
        pathname,
        proofFields
      ),
    },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, "Request failed."));
  }
  return response.json();
}

export async function getMobileMembershipView(
  pubkey: string
): Promise<MobileMembershipView> {
  const response = await fetch(
    `${getApiBaseUrl()}/api/pro/status?pubkey=${encodeURIComponent(pubkey)}`
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Membership status could not be loaded.")
    );
  }
  return (await response.json()) as MobileMembershipView;
}

// Deep link the hosted Stripe Checkout page redirects back to after payment
// (or cancel), letting the browser sheet close itself. Built as a fixed
// string, never Linking.createURL: that helper renders the custom scheme as
// selfsown://pro-return on some platforms and selfsown:///pro-return (empty
// host) on others, and Stripe rejects the empty-host form as "Not a valid
// URL" when creating the Checkout Session.
const PRO_RETURN_DEEP_LINK_BASE = "selfsown://pro-return";

export function createProCheckoutRedirectUrl(
  status: "success" | "cancel"
): string {
  return `${PRO_RETURN_DEEP_LINK_BASE}?status=${status}`;
}

export function createProCheckoutRedirectBaseUrl(): string {
  return PRO_RETURN_DEEP_LINK_BASE;
}

// Classify the deep link the hosted checkout redirected to. openAuthSessionAsync
// resolves with type "success" for BOTH the success and cancel URLs (both match
// the redirect base), so the sheet resolving is never proof of payment — only
// this status param is. Parsed with a regex rather than Linking.parse because
// the custom scheme renders as selfsown://pro-return on some platforms and
// selfsown:///pro-return on others; only the query param matters here.
export function getProCheckoutCallbackStatus(
  input?: string | null
): "success" | "cancel" | null {
  if (!input) return null;
  const status = /[?&]status=([^&#]+)/.exec(input)?.[1];
  return status === "success" || status === "cancel" ? status : null;
}

// Which purchase/manage actions the membership screen offers for a given
// membership state. Trial members are entitled (isPro) but have no payment on
// file, so they must still see the paid plans; members already paying (any
// method) only get the lifetime upgrade, never a second overlapping
// subscription; lifetime members need nothing.
export interface MembershipOffers {
  /** Show the monthly/yearly hosted-checkout buttons. */
  subscriptionPlans: boolean;
  /** Show the one-time Wrangler lifetime checkout button. */
  lifetime: boolean;
  /** Show the Stripe billing-portal manage button. */
  portal: boolean;
}

export function membershipOffers(view: MobileMembershipView): MembershipOffers {
  if (view.isLifetime) {
    return { subscriptionPlans: false, lifetime: false, portal: false };
  }
  const hasPaidAccess = view.isPro && !view.isTrialing;
  return {
    subscriptionPlans: !hasPaidAccess,
    lifetime: true,
    portal: view.billingMethod === "stripe",
  };
}

// Read-only billing history (settled manual invoices + paid Stripe invoices,
// merged newest-first by the server). Signed with the same list_pro_history
// proof as the web dashboard so a seller only ever reads their own history.
export async function getProBillingHistory(
  session: SellerSession
): Promise<MobileProBillingHistoryItem[]> {
  const data = await getSigned(
    session,
    `/api/pro/history?pubkey=${encodeURIComponent(session.pubkey)}`,
    "list_pro_history"
  );
  return (data?.history ?? []) as MobileProBillingHistoryItem[];
}

export async function createProCheckoutSession(
  session: SellerSession,
  plan: ProCheckoutPlan
): Promise<{ url: string }> {
  return postSigned(
    session,
    "/api/pro/checkout-session",
    "create_pro_checkout_session",
    {
      pubkey: session.pubkey,
      plan,
      successUrl: createProCheckoutRedirectUrl("success"),
      cancelUrl: createProCheckoutRedirectUrl("cancel"),
    },
    { plan }
  );
}

export async function createProPortalSession(
  session: SellerSession
): Promise<{ url: string }> {
  return postSigned(
    session,
    "/api/pro/portal-session",
    "create_pro_portal_session",
    { pubkey: session.pubkey }
  );
}

// Best-effort pull of the latest Stripe subscription state after checkout
// returns, so the seller doesn't wait on the webhook. 404s (e.g. a lifetime
// purchase has no subscription) are expected and swallowed.
export async function syncProMembership(session: SellerSession): Promise<void> {
  try {
    await postSigned(session, "/api/pro/sync", "sync_pro_subscription", {
      pubkey: session.pubkey,
    });
  } catch {
    // The webhook reconciles shortly; the status poll below covers the lag.
  }
}

// Poll the public status endpoint until the entitlement lands or the attempt
// budget runs out. Bounded so a slow webhook never spins forever.
export async function waitForMembershipEntitlement(
  pubkey: string,
  { maxAttempts = 6, intervalMs = 2500 } = {}
): Promise<MobileMembershipView | null> {
  let latest: MobileMembershipView | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      latest = await getMobileMembershipView(pubkey);
      if (latest.isPro) return latest;
    } catch {
      // Transient — keep polling within the attempt budget.
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return latest;
}

// Pure display mappings for the billing-history list, mirroring the web
// dashboard (components/settings/pro-membership-section.tsx) and kept separate
// so they are unit-testable without React Native.
export function formatProMoney(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency || "usd").toUpperCase(),
    }).format(amountCents / 100);
  } catch {
    return `$${(amountCents / 100).toFixed(2)}`;
  }
}

export function formatProCoverage(
  start: string | null,
  end: string | null
): string | null {
  const s = start ? new Date(start).getTime() : NaN;
  const e = end ? new Date(end).getTime() : NaN;
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
  };
  const startStr = new Date(s).toLocaleDateString(undefined, opts);
  const endStr = new Date(e).toLocaleDateString(undefined, opts);
  return `${startStr} – ${endStr}`;
}

export function proHistoryTermLabel(item: MobileProBillingHistoryItem): string {
  if (item.lifetime) return "Lifetime";
  if (item.term === "yearly") return "Yearly";
  if (item.term === "monthly") return "Monthly";
  return "—";
}

export function proHistoryMethodLabel(
  method: MobileProBillingHistoryItem["method"]
): string {
  if (method === "stripe") return "Card";
  if (method === "bitcoin") return "Bitcoin";
  if (method === "fiat") return "Manual (fiat)";
  return method;
}

export function formatProDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// Pure display mapping for the membership screen, kept separate so it is
// unit-testable without React Native.
export function describeMembership(view: MobileMembershipView): {
  label: string;
  tone: "success" | "warning" | "danger" | "neutral";
  detail: string;
} {
  if (view.isLifetime) {
    return {
      label: "Wrangler lifetime",
      tone: "success",
      detail: "Lifetime access — no renewals, nothing to cancel.",
    };
  }
  switch (view.status) {
    case "trialing": {
      const end = formatProDate(view.trialEnd);
      return {
        label: "Herd trial",
        tone: "success",
        detail: end
          ? `Your free trial ends ${end}. Add a payment method to keep Herd features.`
          : "Your free trial is active.",
      };
    }
    case "active": {
      const termLabel = view.term === "yearly" ? "yearly" : "monthly";
      const end = formatProDate(view.currentPeriodEnd);
      return {
        label: `Herd — ${termLabel}`,
        tone: "success",
        detail: view.cancelAtPeriodEnd
          ? `Canceled — Herd features stay on until ${end ?? "the period ends"}.`
          : end
            ? `Renews ${end}.`
            : "Your subscription is active.",
      };
    }
    case "grace": {
      const end = formatProDate(view.graceUntil);
      return {
        label: "Herd — past due",
        tone: "warning",
        detail: end
          ? `Your last payment failed. Update your card before ${end} to keep Herd features.`
          : "Your last payment failed. Update your card to keep Herd features.",
      };
    }
    case "readonly":
      return {
        label: "Herd — read-only",
        tone: "danger",
        detail:
          "Your membership lapsed. Your shop is still live but locked — renew to edit.",
      };
    case "hidden":
      return {
        label: "Herd — hidden",
        tone: "danger",
        detail:
          "Your membership lapsed and your Pro shop is hidden. Renew to bring it back.",
      };
    default:
      return {
        label: "Free",
        tone: "neutral",
        detail:
          "Upgrade to Herd for a custom storefront, email flows, and more.",
      };
  }
}
