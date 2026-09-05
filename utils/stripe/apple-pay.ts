import Stripe from "stripe";
import { getDomainByHost } from "@/utils/db/custom-domains";

// Apple Pay requires each checkout domain to be registered with Apple on the
// Stripe account that owns the charge (the connected account for Connect
// direct charges, the platform account otherwise). Registration is durable,
// so pairs are cached in-process and Stripe's "already registered" error is
// absorbed. Failures are logged and swallowed: a failed registration must
// never block checkout — Apple Pay simply stays unavailable on that domain
// until a later attempt succeeds. Verification itself is Apple fetching the
// /.well-known/apple-developer-merchantid-domain-association file (env-backed
// route), so registration alone grants nothing.

// Constructed lazily: no client exists (or is needed) when the key is absent.
const registeredDomains = new Set<string>();

export function normalizeRegistrableHost(host: string): string | null {
  const bare = (host.split(":")[0] || "").toLowerCase();
  // Apple verifies by fetching the association file over HTTPS, so only real
  // domains can ever register — localhost and bare hosts are skipped.
  return bare.includes(".") ? bare : null;
}

/**
 * The only hosts we will register: the platform's own host, or a verified
 * custom domain owned by THIS seller. A spoofed Host header must never bind
 * an arbitrary domain to a seller's Stripe account.
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
    if (baseUrl) {
      const platformHost = normalizeRegistrableHost(new URL(baseUrl).host);
      if (platformHost && host === platformHost) return host;
    }
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
  // Register in BOTH domain systems: the legacy Apple Pay domains API and the
  // newer payment method domains API (the Dashboard "Payment method domains"
  // page, and the API pmd-registration requires for Connect direct charges).
  // Elements surfaces differ in which they consult; both verify via the same
  // association file and both are durable.
  const attempt = async (
    label: string,
    call: () => Promise<unknown>
  ): Promise<boolean> => {
    try {
      await call();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("already")) return true;
      console.error(
        `Apple Pay domain registration failed (${label}):`,
        message
      );
      return false;
    }
  };
  const legacyOk = await attempt("apple_pay/domains", () =>
    stripe.applePayDomains.create({ domain_name: domain }, options)
  );
  const pmdOk = await attempt("payment_method_domains", () =>
    stripe.paymentMethodDomains.create({ domain_name: domain }, options)
  );
  // Cache only when every path succeeded (or was already registered), so a
  // transient Stripe failure retries on the next checkout.
  if (legacyOk && pmdOk) registeredDomains.add(cacheKey);
}
