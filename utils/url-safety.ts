import { lookup } from "dns/promises";
import net from "net";
import { createRequire } from "module";

// Importing Undici's public entry point initializes browser fetch primitives,
// which are intentionally absent in our jsdom test environment. The Agent
// dispatcher itself is server-only and does not need those primitives.
const require = createRequire(import.meta.url);
const Agent = require("undici/lib/dispatcher/agent") as new (opts: {
  keepAliveTimeout: number;
  keepAliveMaxTimeout: number;
  connect: {
    lookup: (
      name: string,
      options: { family?: number; all?: boolean },
      callback: (
        error: Error | null,
        address: string | ResolvedAddress[],
        family?: 4 | 6
      ) => void
    ) => void;
  };
}) => {
  dispatch: unknown;
};

// Shared SSRF guards for any server-side outbound fetch of a user-supplied
// URL. Extracted from pages/api/og-preview.ts so the storefront design
// importer (which additionally fetches linked stylesheets) reuses the exact
// same host allow-listing. Every outbound fetch of caller-controlled URLs
// MUST go through `safeFetch` (or at least validate the host with
// `isSafePublicHostname`) or we become an SSRF amplifier.

export const SAFE_FETCH_USER_AGENT =
  "Mozilla/5.0 (compatible; MilkMarket/1.0; +https://milk.market)";

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  ) {
    return true;
  }

  const [a, b, c] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 2) return true; // TEST-NET-1
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true;

  return false;
}

// Pull the embedded IPv4 out of an IPv4-mapped/compatible IPv6 address so it
// can be checked against the IPv4 rules. Handles both the dotted tail
// (`::ffff:127.0.0.1`, `::127.0.0.1`) and the hex-mapped tail (`::ffff:7f00:1`).
function extractEmbeddedIPv4(normalized: string): string | null {
  const dotted = normalized.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted && dotted[1]) return dotted[1];

  // IPv4-compatible addresses have 96 zero bits (`::7f00:1`) and mapped
  // addresses use `::ffff:`. Both can carry a private IPv4 destination.
  const hexMapped = normalized.match(
    /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/
  );
  if (hexMapped && hexMapped[1] && hexMapped[2]) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

export function isPrivateIPv6(ip: string): boolean {
  let normalized = ip.replace(/^\[|\]$/g, "").toLowerCase();
  const zoneIdx = normalized.indexOf("%"); // strip zone id, e.g. fe80::1%eth0
  if (zoneIdx !== -1) normalized = normalized.slice(0, zoneIdx);

  if (normalized === "::1") return true;
  if (normalized === "::") return true;
  // fe80::/10 includes fe80 through febf, not merely the fe80::/16.
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("ff")) return true; // multicast
  if (
    normalized.startsWith("2001:db8:") || // documentation prefix
    normalized.startsWith("2001:0:")
  ) {
    return true; // documentation and Teredo
  }

  // IPv4-mapped/compatible addresses (e.g. ::ffff:127.0.0.1, ::ffff:7f00:1)
  // tunnel an IPv4 address through IPv6; validate that against the IPv4 rules
  // so a dual-stack host can't be tricked into reaching loopback/internal IPs.
  const embedded = extractEmbeddedIPv4(normalized);
  if (embedded) return isPrivateIPv4(embedded);

  return false;
}

type ResolvedAddress = { address: string; family: 4 | 6 };

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
}

async function resolveSafePublicAddresses(
  hostname: string
): Promise<ResolvedAddress[] | null> {
  const lowered = normalizeHostname(hostname);
  if (
    lowered === "localhost" ||
    lowered.endsWith(".localhost") ||
    lowered.endsWith(".local")
  ) {
    return null;
  }

  const ipType = net.isIP(lowered);
  if (ipType === 4) {
    return isPrivateIPv4(lowered) ? null : [{ address: lowered, family: 4 }];
  }
  if (ipType === 6) {
    return isPrivateIPv6(lowered) ? null : [{ address: lowered, family: 6 }];
  }

  try {
    const addresses = await lookup(lowered, { all: true });
    if (addresses.length === 0) return null;

    for (const addr of addresses) {
      if (
        (addr.family === 4 && isPrivateIPv4(addr.address)) ||
        (addr.family === 6 && isPrivateIPv6(addr.address))
      ) {
        return null;
      }
    }

    return addresses
      .filter(
        (addr): addr is ResolvedAddress =>
          addr.family === 4 || addr.family === 6
      )
      .map((addr) => ({ address: addr.address, family: addr.family }));
  } catch {
    return null;
  }
}

export async function isSafePublicHostname(hostname: string): Promise<boolean> {
  return (await resolveSafePublicAddresses(hostname)) !== null;
}

/**
 * Node-style DNS lookup that resolves through the SSRF classifier and only
 * ever returns vetted PUBLIC addresses. Pass it as the `lookup` option to
 * ws/http connections so the connection itself is pinned to the checked
 * address — there is no re-resolution window for DNS rebinding between
 * validation and connect. Honors both the single-address and all-address
 * callback shapes; SNI/certificate validation still uses the original
 * hostname. Fails closed (error callback) for private/unresolvable hosts.
 */
export function createPublicOnlyLookup() {
  return (
    hostname: string,
    options: { all?: boolean },
    callback: (
      error: Error | null,
      address?: string | ResolvedAddress[],
      family?: 4 | 6
    ) => void
  ): void => {
    resolveSafePublicAddresses(hostname)
      .then((addresses) => {
        if (!addresses || addresses.length === 0) {
          callback(
            new Error(`Blocked host with no public address: ${hostname}`)
          );
          return;
        }
        if (options && options.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0]!.address, addresses[0]!.family);
        }
      })
      .catch((err) =>
        callback(err instanceof Error ? err : new Error(String(err)))
      );
  };
}

function pinnedDispatcher(
  hostname: string,
  addresses: ResolvedAddress[]
): InstanceType<typeof Agent> {
  let next = 0;
  const expectedHost = normalizeHostname(hostname);
  return new Agent({
    // A short keep-alive prevents a per-request dispatcher from retaining idle
    // sockets after the caller has consumed its response.
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
    connect: {
      lookup(name, options, callback) {
        const returnAll = options.all === true;
        if (normalizeHostname(name) !== expectedHost) {
          callback(
            new SafeFetchError("Unexpected DNS lookup host"),
            returnAll ? [] : "",
            returnAll ? undefined : 4
          );
          return;
        }
        const matching = addresses.filter(
          (address) => !options.family || address.family === options.family
        );
        if (returnAll) {
          callback(null, matching.length > 0 ? matching : addresses);
          return;
        }
        const selected = matching[next++ % matching.length] ?? addresses[0]!;
        callback(null, selected.address, selected.family);
      },
    },
  });
}

/**
 * Parse a caller-supplied URL, returning it only when it is an http(s) URL on
 * a standard web port. Returns null for anything else (other schemes, weird
 * ports, unparseable input) so callers can fail closed.
 */
export function parseHttpUrl(value: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  // Credentials have no legitimate use for public image/document URLs and can
  // hide the actual destination in a URL displayed to a user.
  if (parsed.username || parsed.password || !parsed.hostname) {
    return null;
  }
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    return null;
  }
  return parsed;
}

export class SafeFetchError extends Error {}

export interface SafeFetchOptions {
  timeoutMs?: number;
  accept?: string;
  // When true, follow up to `maxRedirects` redirects, re-validating each hop's
  // host against `isSafePublicHostname` (so a redirect can't be used to reach
  // an internal address). When false (default), a redirect is returned as-is.
  followRedirects?: boolean;
  maxRedirects?: number;
}

/**
 * SSRF-guarded fetch. Validates the URL scheme/port and resolves the host to
 * ensure it is public before every request (including each followed redirect
 * hop). Always uses a bounded timeout and a manual redirect policy.
 *
 * Throws SafeFetchError when the URL/host is not allowed or on too many
 * redirects; network/timeout errors propagate from the underlying fetch.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {}
): Promise<Response> {
  const {
    timeoutMs = 6000,
    accept = "text/html,application/xhtml+xml",
    followRedirects = false,
    maxRedirects = 3,
  } = opts;

  let currentUrl = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = parseHttpUrl(currentUrl);
    if (!parsed) {
      throw new SafeFetchError("Invalid or disallowed URL");
    }
    const addresses = await resolveSafePublicAddresses(parsed.hostname);
    if (!addresses) {
      throw new SafeFetchError("URL host is not allowed");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      // Pin the connection to addresses vetted above. Calling fetch with the
      // hostname still preserves HTTP Host and TLS SNI, unlike replacing it
      // with an IP literal, while the custom lookup closes DNS-rebinding TOCTOU.
      response = await fetch(parsed.toString(), {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent": SAFE_FETCH_USER_AGENT,
          Accept: accept,
        },
        dispatcher: pinnedDispatcher(parsed.hostname, addresses),
      } as RequestInit);
    } finally {
      clearTimeout(timeout);
    }

    if (followRedirects && response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return response;
      try {
        currentUrl = new URL(location, parsed).toString();
      } catch {
        throw new SafeFetchError("Invalid redirect location");
      }
      continue;
    }

    return response;
  }

  throw new SafeFetchError("Too many redirects");
}
