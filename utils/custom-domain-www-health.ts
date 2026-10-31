import dns from "dns";
import { promisify } from "util";
import { SITE_HOST } from "./site-url";
import { probeWwwTls } from "./www-tls-probe";

const resolveCname = promisify(dns.resolveCname);
const resolve4 = promisify(dns.resolve4);

export const PRIMARY_HOST = (
  process.env.REPLIT_DEPLOYMENT_HOST || SITE_HOST
).toLowerCase();

export const VALID_CNAME_TARGETS = [PRIMARY_HOST, SITE_HOST, "milk-market.replit.app"]
  .map((h) => h.toLowerCase().replace(/\.$/, ""))
  .filter((v, i, a) => a.indexOf(v) === i);

export function normalizeHost(h: string): string {
  return h.toLowerCase().trim().replace(/\.$/, "");
}

export function cnameMatches(observed: string, expected: string): boolean {
  const o = normalizeHost(observed);
  const e = normalizeHost(expected);
  return o === e || o.endsWith("." + e);
}

export type WwwHealthState =
  // www DNS points at the platform AND https://www.<domain>/ terminates TLS.
  | "ok"
  // No www record, or www points somewhere else (e.g. a registrar parking
  // page). A parked host can serve perfectly valid HTTPS, so DNS MUST be
  // checked before any TLS verdict — a green TLS probe against a parking
  // page would tell the admin "attached" while buyers never reach us.
  | "dns_mismatch"
  // DNS points at us but the TLS handshake fails cert validation → the www
  // variant was never attached under Publishing → Domains.
  | "certificate"
  // DNS points at us but the probe couldn't connect (timeout, refused).
  // Inconclusive — often propagation or a transient edge hiccup.
  | "unreachable";

export interface WwwHealth {
  applicable: boolean;
  state: WwwHealthState;
  // Convenience mirrors of `state` for existing consumers.
  resolves: boolean;
  tlsOk: boolean | null;
  tlsReason: "certificate" | "unreachable" | null;
  observed: { cname: string[] | null; a: string[] | null };
}

/**
 * Full health check for www.<domain>: DNS first, TLS only once DNS points at
 * the deployment. Returns null for non-apex domains (nobody types
 * www.shop.example.com). Shared by the seller-facing verify route and the
 * admin domains list so both dashboards report the SAME state and can't
 * drift. Never throws.
 */
export async function checkWwwVariantHealth(
  domain: string
): Promise<WwwHealth | null> {
  if (domain.split(".").length > 2) return null;

  const wwwHost = `www.${domain}`;
  const observed: { cname: string[] | null; a: string[] | null } = {
    cname: null,
    a: null,
  };
  let match = false;
  try {
    const recs = await resolveCname(wwwHost);
    observed.cname = recs;
    match = recs.some((r) =>
      VALID_CNAME_TARGETS.some((t) => cnameMatches(r, t))
    );
  } catch {
    // No CNAME on www — try A records.
  }
  if (!match) {
    try {
      const targetIps = await resolve4(PRIMARY_HOST);
      const got = await resolve4(wwwHost);
      observed.a = got;
      const targetSet = new Set(targetIps.map((s) => s.trim()));
      match = got.length > 0 && got.every((ip) => targetSet.has(ip.trim()));
    } catch {
      // ignore
    }
  }

  if (!match) {
    return {
      applicable: true,
      state: "dns_mismatch",
      resolves: false,
      tlsOk: null,
      tlsReason: null,
      observed,
    };
  }

  const probe = await probeWwwTls(wwwHost);
  const state: WwwHealthState = probe.ok
    ? "ok"
    : probe.reason === "certificate"
      ? "certificate"
      : "unreachable";
  return {
    applicable: true,
    state,
    resolves: true,
    tlsOk: probe.ok,
    tlsReason: probe.reason,
    observed,
  };
}
