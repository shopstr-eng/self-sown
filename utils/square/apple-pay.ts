// Apple Pay domain activation for Square-connected sellers.
//
// Square's platform Apple Pay flow has two halves: hosting the merchant
// domain-verification file (served by
// pages/api/.well-known/apple-developer-merchantid-domain-association.ts) and
// ACTIVATING each merchant domain with Square via POST /v2/apple-pay/domains
// ("bulk activate Apple Pay on the Web with Square for merchants using their
// platform"). Until a domain is activated, the Web Payments SDK's
// payments.applePay() treats it as unverified and silently hides the Apple Pay
// button.
//
// The register-domain call is authenticated as the PLATFORM (SQUARE_ACCESS_TOKEN
// from the Developer Dashboard credentials page), not the seller's OAuth token.
// When the platform token is absent the feature is off and every call is a
// no-op.
//
// Host trust mirrors utils/stripe/apple-pay.ts: only a verified custom domain
// owned by the seller (or the self-host instance's own domain) is ever
// activated — a spoofed Host header must never register an arbitrary domain
// with the platform. Only a VERIFIED registration is cached in-process; a
// PENDING one stays retryable so a later checkout picks it up once Apple
// finishes validating. All calls are single-flight per domain, bounded by a
// short abort timeout, and never throw: a Square outage can never block
// checkout or domain verification — Apple Pay simply stays hidden until an
// activation succeeds.

import {
  normalizeRegistrableHost,
  trustedRegistrationHost,
} from "@/utils/stripe/apple-pay";
import { hasSquareConnection } from "@/utils/db/square-service";
import { isSelfHost } from "@/utils/self-host/config";
import { getSquareConnectBaseUrl, getSquareApiVersion } from "./square-config";

const activatedDomains = new Set<string>();
const inFlight = new Map<string, Promise<string | null>>();

// The activation call is awaited inline on checkout paths, so a stalled Square
// API must not hold a buyer (or a domain verification) hostage. 5s is generous
// for one POST and worst case is paid once per domain per process.
const ACTIVATION_TIMEOUT_MS = 5000;

// Platform access token (Developer Dashboard → Credentials). Not the OAuth
// client secret, and not a seller's merchant token.
function getPlatformAccessToken(): string | null {
  return process.env.SQUARE_ACCESS_TOKEN || null;
}

// POST the domain to Square's platform register-domain API. Returns true only
// when the domain is confirmed VERIFIED (or Square reports it as already
// registered, which implies a prior activation). A PENDING response is NOT
// success: Apple may still be validating the association file, so the domain
// stays retryable on the next checkout.
async function registerDomainWithSquare(
  host: string,
  token: string
): Promise<boolean> {
  try {
    const res = await fetch(
      `${getSquareConnectBaseUrl()}/v2/apple-pay/domains`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Square-Version": getSquareApiVersion(),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ domain_name: host }),
        signal: AbortSignal.timeout(ACTIVATION_TIMEOUT_MS),
      }
    );
    const text = await res.text().catch(() => "");
    if (res.ok) {
      let status = "";
      try {
        status = String(JSON.parse(text)?.status ?? "").toUpperCase();
      } catch {
        status = "";
      }
      if (status === "VERIFIED") return true;
      // PENDING (or unknown) means Apple is still validating — and Square gives
      // no endpoint to re-check a domain's status, so the ONLY signal of
      // readiness is a VERIFIED response from this call. An "already
      // registered" duplicate response is likewise not proof of readiness.
      // Either way: do NOT cache; the next checkout re-POSTs and eventually
      // observes VERIFIED.
      console.warn(
        `Square Apple Pay domain activation for ${host} is not yet verified (status: ${status || "unknown"}); will retry`
      );
      return false;
    }
    console.error(
      `Square Apple Pay domain activation failed (${res.status}):`,
      text.slice(0, 500)
    );
    return false;
  } catch (error) {
    console.error(
      "Square Apple Pay domain activation failed:",
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

/**
 * Best-effort activation of `hostHeader` for Square Apple Pay. Never throws;
 * safe to await inline on a checkout path. Returns the activated domain (or the
 * domain that was already activated), null when skipped/pending/failed.
 */
export async function activateSquareApplePayDomain(
  hostHeader: string | string[] | undefined,
  sellerPubkey?: string | null
): Promise<string | null> {
  const token = getPlatformAccessToken();
  if (!token) return null;

  const host = await trustedRegistrationHost(hostHeader, sellerPubkey);
  if (!host) return null;

  // On the hosted platform, only activate for sellers who actually take card
  // payments through Square (a Stripe seller's domain never runs the Square
  // SDK). Self-host is a single tenant; isSquareConfigured gating happens at
  // the checkout route, so the connection check is skipped here.
  if (!isSelfHost()) {
    if (!sellerPubkey) return null;
    try {
      if (!(await hasSquareConnection(sellerPubkey))) return null;
    } catch (error) {
      // A DB blip must not block checkout; activation retries on the next one.
      console.error(
        "Square Apple Pay activation: connection check failed:",
        error
      );
      return null;
    }
  }

  if (activatedDomains.has(host)) return host;

  // Single-flight: concurrent checkouts on the same domain share one request.
  const existing = inFlight.get(host);
  if (existing) return existing;

  const attempt = registerDomainWithSquare(host, token)
    .then((verified) => {
      if (verified) {
        activatedDomains.add(host);
        return host;
      }
      // Not cached: a transient failure or PENDING status retries on the next
      // checkout/verification.
      return null;
    })
    .finally(() => {
      inFlight.delete(host);
    });
  inFlight.set(host, attempt);
  return attempt;
}

// Test-only hook: the caches are module state, so suites reset them between
// cases.
export function __resetActivatedSquareApplePayDomains(): void {
  activatedDomains.clear();
  inFlight.clear();
}

export { normalizeRegistrableHost };
