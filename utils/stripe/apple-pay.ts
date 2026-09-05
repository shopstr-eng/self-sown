import Stripe from "stripe";

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
  try {
    await stripe.applePayDomains.create(
      { domain_name: domain },
      connectedAccountId ? { stripeAccount: connectedAccountId } : undefined
    );
    registeredDomains.add(cacheKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("already")) {
      registeredDomains.add(cacheKey);
      return;
    }
    console.error("Apple Pay domain registration failed:", message);
  }
}
