import dns from "dns";
import { promisify } from "util";
import {
  PRIMARY_HOST,
  VALID_CNAME_TARGETS,
  cnameMatches,
} from "./custom-domain-www-health";
import { probeWwwTls } from "./www-tls-probe";
import {
  markVerified,
  setTlsStatus,
  type CustomDomainRow,
  type TlsStatus,
} from "./db/custom-domains";

const resolveCname = promisify(dns.resolveCname);
const resolve4 = promisify(dns.resolve4);
const resolveTxt = promisify(dns.resolveTxt);

export interface DomainDnsObservation {
  cname: string[] | null;
  a: string[] | null;
  txt: string[] | null;
}

export interface DomainDnsCheck {
  // CNAME or A record points at the deployment.
  dnsTargetMatch: boolean;
  // TXT ownership token matches (vacuously true when no token was issued).
  txtMatch: boolean;
  verified: boolean;
  observed: DomainDnsObservation;
}

/**
 * The DNS ownership + target check behind custom-domain verification.
 * Shared by the seller-facing verify route and the automatic lifecycle
 * advancer so the manual button and the background transition can never
 * disagree about what "verified" means. Never throws: every resolver
 * failure just means "not matched".
 */
export async function checkDomainDns(
  domain: string,
  expectedToken: string | null
): Promise<DomainDnsCheck> {
  const observed: DomainDnsObservation = { cname: null, a: null, txt: null };

  let cnameMatch = false;
  let aMatch = false;
  let txtMatch = !expectedToken;

  try {
    const recs = await resolveCname(domain);
    observed.cname = recs;
    cnameMatch = recs.some((r) =>
      VALID_CNAME_TARGETS.some((t) => cnameMatches(r, t))
    );
  } catch {
    // No CNAME — try A records.
  }

  if (!cnameMatch) {
    try {
      const targetIps = await resolve4(PRIMARY_HOST);
      const got = await resolve4(domain);
      observed.a = got;
      const targetSet = new Set(targetIps.map((s) => s.trim()));
      aMatch = got.length > 0 && got.every((ip) => targetSet.has(ip.trim()));
    } catch {
      // ignore
    }
  }

  if (expectedToken) {
    try {
      // Accept both the current and pre-rename TXT owner names so sellers
      // who already added `_milkmarket.` records keep verifying without
      // touching their DNS.
      const [primary, legacy] = await Promise.allSettled([
        resolveTxt(`_self-sown.${domain}`),
        resolveTxt(`_milkmarket.${domain}`),
      ]);
      const txt = [
        ...(primary.status === "fulfilled" ? primary.value : []),
        ...(legacy.status === "fulfilled" ? legacy.value : []),
      ];
      if (txt.length === 0) throw new Error("no TXT records");
      const flat = txt.map((parts) => parts.join("")).flat();
      observed.txt = flat;
      txtMatch = flat.some((v) => v.trim() === expectedToken);
    } catch {
      observed.txt = [];
      txtMatch = false;
    }
  }

  const dnsTargetMatch = cnameMatch || aMatch;
  return {
    dnsTargetMatch,
    txtMatch,
    verified: dnsTargetMatch && txtMatch,
    observed,
  };
}

/**
 * The CNAME target sellers point "www" at. Single source for the value shown
 * in the seller dashboard AND the admin panel so the two can't drift.
 */
export const WWW_CNAME_TARGET = VALID_CNAME_TARGETS[0];

export interface AdvanceResult {
  changed: boolean;
  verified: boolean;
  from: TlsStatus;
  to: TlsStatus;
}

export type CustomDomainLifecycleEvent =
  | { type: "dns_verified" }
  | { type: "tls_ready" };

export interface CustomDomainLifecycleState {
  verified: boolean;
  tlsStatus: TlsStatus;
}

/**
 * Pure transition relation for automatic domain advancement. Probe failures
 * produce no event, so they cannot demote a working domain. Administrative
 * status changes remain an explicit override outside this automatic machine.
 */
export function transitionCustomDomainState(
  state: CustomDomainLifecycleState,
  event: CustomDomainLifecycleEvent
): CustomDomainLifecycleState {
  if (event.type === "dns_verified" && state.tlsStatus === "pending_dns") {
    return { verified: true, tlsStatus: "dns_verified" };
  }

  if (
    event.type === "tls_ready" &&
    state.verified &&
    (state.tlsStatus === "dns_verified" || state.tlsStatus === "attached")
  ) {
    return { verified: true, tlsStatus: "active" };
  }

  return state;
}

/**
 * Move a custom-domain row forward through its lifecycle based on live
 * observation, so neither the seller nor the admin has to click anything
 * for statuses to converge:
 *
 *   pending_dns  → dns_verified   when the domain's DNS now verifies
 *   dns_verified → active         when https://<domain>/ terminates TLS
 *   attached     → active         (same probe; "attached but cert pending"
 *                                  isn't externally observable, so we jump
 *                                  straight to active once the cert is live)
 *
 * Forward-only by design: a failed probe never demotes a row (a transient
 * outage must not take a live domain backwards), "active" rows are trusted
 * (no per-view probe cost), and "failed" is an admin-set terminal state.
 * The admin status dropdown remains the manual override.
 *
 * Wired into the admin domains list and the seller's own custom-domain GET,
 * so statuses converge every time either dashboard is opened. Never throws.
 */
export async function advanceCustomDomainStatus(
  row: CustomDomainRow
): Promise<AdvanceResult> {
  const from = row.tls_status;
  let state: CustomDomainLifecycleState = {
    verified: row.verified,
    tlsStatus: from,
  };

  try {
    if (state.tlsStatus === "pending_dns") {
      const dnsCheck = await checkDomainDns(row.domain, row.verification_token);
      if (dnsCheck.verified) {
        const next = transitionCustomDomainState(state, {
          type: "dns_verified",
        });
        await markVerified(row.pubkey);
        state = next;
      }
    }

    if (
      state.verified &&
      (state.tlsStatus === "dns_verified" || state.tlsStatus === "attached")
    ) {
      // probeWwwTls is host-generic despite the name: any HTTPS response
      // means the deployment terminated TLS for this host, i.e. the cert is
      // provisioned. DNS already points at us for a verified row, so a
      // parked-registrar false positive isn't possible here.
      const probe = await probeWwwTls(row.domain);
      if (probe.ok) {
        const next = transitionCustomDomainState(state, {
          type: "tls_ready",
        });
        await setTlsStatus(row.domain, "active");
        state = next;
      }
    }
  } catch (err) {
    // Fail-open: a storage or network hiccup leaves the stored status
    // untouched rather than corrupting it; the next view retries.
    console.error(
      `[custom-domain-lifecycle] advance failed for ${row.domain}:`,
      err
    );
  }

  return {
    changed: state.verified !== row.verified || state.tlsStatus !== from,
    verified: state.verified,
    from,
    to: state.tlsStatus,
  };
}
