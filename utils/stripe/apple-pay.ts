import Stripe from "stripe";
import { getDomainByHost } from "@/utils/db/custom-domains";
import { isSelfHost } from "@/utils/self-host/config";

// Apple Pay requires each checkout domain to be registered with Stripe on the
// account that owns the charge (the connected account for Connect direct
// charges, the platform account otherwise). Registration is a single Payment
// Method Domain API call per domain+account: Stripe handles Apple's merchant
// validation behind the scenes, so there is NO association file for us or
// sellers to host (the legacy apple_pay/domains API is deliberately not
// called). Registration is durable — pairs are cached in-process and Stripe's
// "already registered" error is absorbed. Failures are logged and swallowed:
// a failed registration must never block checkout — Apple Pay simply stays
// unavailable on that domain until a later attempt succeeds.

// Constructed lazily: no client exists (or is needed) when the key is absent.
const registeredDomains = new Set<string>();

export function normalizeRegistrableHost(host: string): string | null {
  const bare = (host.split(":")[0] || "").toLowerCase();
  // Apple verifies by fetching the association file over HTTPS, so only real
  // domains can ever register — localhost and bare hosts are skipped.
  return bare.includes(".") ? bare : null;
}

/**
 * The only hosts we will register: the canonical platform host, a verified
 * custom domain owned by THIS seller — or, on a self-host instance
 * (SS_SELF_HOST env-gated, never header-trusted), the instance's own
 * configured base host. A spoofed Host header must never bind an arbitrary
 * domain to a seller's Stripe account.
 *
 * Platform-host registration is PER CHARGE-OWNING ACCOUNT: a seller's direct
 * charge registers the host on that seller's connected account, platform
 * charges on the platform account — so each seller's Apple Pay eligibility on
 * the platform host is independent (per-seller). The PMD flow needs no hosted
 * association file, so no platform-host file is required for Stripe.
 */
export async function trustedRegistrationHost(
  hostHeader: string | string[] | undefined,
  sellerPubkey?: string | null
): Promise<string | null> {
  const host = normalizeRegistrableHost(
    Array.isArray(hostHeader) ? hostHeader[0] || "" : hostHeader || ""
  );
  if (!host) return null;
  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
    const ownHost = baseUrl
      ? normalizeRegistrableHost(new URL(baseUrl).host)
      : null;
    if (isSelfHost()) {
      // Self-host: the instance's own configured domain is the tenant's.
      return ownHost && host === ownHost ? host : null;
    }
    // Hosted platform: the canonical platform host is registrable (see the
    // doc comment — per-account registration keeps eligibility per-seller).
    if (ownHost && host === ownHost) return host;
    if (sellerPubkey) {
      const domain = await getDomainByHost(host);
      if (
        domain?.verified &&
        domain.pubkey.toLowerCase() === sellerPubkey.toLowerCase()
      ) {
        return host;
      }
    }
  } catch {
    // Best-effort feature: a lookup/parse failure just skips registration.
  }
  return null;
}

// Apple Pay can actually run on a domain only when its payment method domain
// is enabled AND Apple's status is active — a bare successful create proves
// neither, and "already registered" least of all (a domain can be disabled
// deliberately or have been left inactive at creation).
function pmdApplePayActive(
  pmd: Stripe.PaymentMethodDomain | null | undefined
): boolean {
  return !!pmd && pmd.enabled === true && pmd.apple_pay.status === "active";
}

export async function registerApplePayDomain(
  host: string,
  connectedAccountId?: string | null
): Promise<void> {
  if (!process.env.STRIPE_SECRET_KEY) return;
  const domain = normalizeRegistrableHost(host);
  if (!domain) return;
  const cacheKey = `${connectedAccountId ?? "platform"}:${domain}`;
  if (registeredDomains.has(cacheKey)) return;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-09-30.clover",
  });
  const options = connectedAccountId
    ? { stripeAccount: connectedAccountId }
    : undefined;
  // Create the payment method domain. On a duplicate, create returns nothing
  // usable, so list by domain_name on the same account to find the existing
  // PMD and inspect its real state.
  let pmd: Stripe.PaymentMethodDomain | null = null;
  try {
    pmd = await stripe.paymentMethodDomains.create(
      { domain_name: domain },
      options
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("already")) {
      console.error("Apple Pay domain registration failed:", message);
      // Not cached: a transient Stripe failure retries on the next checkout.
      return;
    }
    try {
      const existing = await stripe.paymentMethodDomains.list(
        { domain_name: domain },
        options
      );
      pmd = existing.data[0] ?? null;
    } catch (lookupError) {
      console.error(
        "Apple Pay domain lookup failed:",
        lookupError instanceof Error
          ? lookupError.message
          : String(lookupError)
      );
      return;
    }
  }
  // Re-enable a deliberately-disabled PMD (e.g. a past sweep): the current
  // policy is that checkout domains get Apple Pay, and this function only
  // runs on checkout paths, so an enabled+active end state is always the
  // goal. If Apple Pay must be turned off for a domain again, the off switch
  // is the registration CALL SITES, not the PMD flag — this will re-enable it.
  if (pmd && pmd.enabled === false) {
    try {
      pmd = await stripe.paymentMethodDomains.update(
        pmd.id,
        { enabled: true },
        options
      );
    } catch (error) {
      console.error(
        "Apple Pay domain re-enable failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  // Validate unless the domain is already enabled with Apple Pay active —
  // validation nudges a domain whose requirements weren't met at creation
  // into an active state.
  if (pmd && !pmdApplePayActive(pmd)) {
    try {
      pmd = await stripe.paymentMethodDomains.validate(pmd.id, options);
    } catch (error) {
      console.error(
        "Apple Pay domain validation failed:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  // Cache only a confirmed-active registration; anything else stays retryable
  // on the next checkout.
  if (pmdApplePayActive(pmd)) registeredDomains.add(cacheKey);
}
