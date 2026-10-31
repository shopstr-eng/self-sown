import { safeFetch, SafeFetchError } from "./url-safety";

export type WwwTlsProbeResult = {
  // true when https://<host>/ completed a TLS handshake and returned any HTTP
  // response (a 301 to the apex, a 404 — all fine; we only care that TLS
  // terminated for this host).
  ok: boolean;
  // Why it failed, when it failed:
  //   "certificate"  — TLS handshake/cert validation failed → the host is not
  //                    attached to the deployment (or the cert hasn't been
  //                    provisioned yet). This is the "admin forgot to attach
  //                    the www variant" case.
  //   "unreachable"  — connection failed/timed out or the host didn't resolve
  //                    publicly → DNS-level problem, not a cert problem.
  reason: "certificate" | "unreachable" | null;
  // Underlying error code (e.g. ERR_TLS_CERT_ALTNAME_INVALID) for display.
  errorCode: string | null;
};

// Node/undici surface certificate failures under these error codes. Kept
// broad on purpose: any of them mean "the TLS layer failed", which for a
// host whose DNS already points at our deployment means the certificate for
// that host isn't attached/provisioned.
const CERT_ERROR_PATTERN =
  /CERT|UNABLE_TO_(VERIFY|GET_ISSUER|DECRYPT)|SELF_SIGNED|ERR_TLS|EPROTO|SSL_ROUTINES|HANDSHAKE/i;

/**
 * Probe whether https://<host>/ terminates TLS. Used to tell "www DNS is
 * missing" apart from "www DNS points at us but nobody attached the www
 * variant under Publishing → Domains" — both previously showed as a generic
 * green/yellow DNS state while buyers hit a browser cert error.
 *
 * Goes through safeFetch (SSRF guard: scheme/port validation + public-IP
 * pinning) per the server-side user-URL fetch rule. Never throws.
 */
export async function probeWwwTls(
  host: string,
  timeoutMs = 5000
): Promise<WwwTlsProbeResult> {
  try {
    // HEAD: we only need the handshake + any status line. safeFetch uses a
    // manual redirect policy, so the platform's www→apex 301 comes back as a
    // normal response instead of being followed.
    await safeFetch(`https://${host}/`, { method: "HEAD", timeoutMs });
    return { ok: true, reason: null, errorCode: null };
  } catch (err: any) {
    const code: string = String(err?.cause?.code ?? err?.code ?? "");
    const message: string = String(err?.message ?? "");
    if (err instanceof SafeFetchError) {
      // URL/host rejected by the SSRF guard (e.g. didn't resolve to a public
      // IP) — a DNS-level failure, not a certificate one.
      return {
        ok: false,
        reason: "unreachable",
        errorCode: code || message || null,
      };
    }
    if (CERT_ERROR_PATTERN.test(code) || CERT_ERROR_PATTERN.test(message)) {
      return { ok: false, reason: "certificate", errorCode: code || null };
    }
    // AbortError (timeout), ECONNREFUSED, ENOTFOUND, etc.
    return { ok: false, reason: "unreachable", errorCode: code || null };
  }
}
