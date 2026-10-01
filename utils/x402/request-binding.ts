// x402 lnbtc request binding: compute the `requestHash` that binds a payment
// to the exact request being purchased, per the `http:1` and `mcp:1` binding
// profiles.
//
// requestHash = SHA-256( UTF8( JCS( bindingObject ) ) )
//
// Documented deviation from the spec: for the http:1 profile the spec hashes
// the raw request body bytes. Next.js parses the JSON body before our route
// sees it, so we hash JCS(parsed body) instead — deterministic and identical
// to the raw-byte hash whenever the client sends canonical JSON. The other
// documented deviation (mint-issued invoices cannot carry the request hash in
// their description-hash field) lives in utils/x402/server.ts.

import { createHash } from "crypto";
import { canonicalizeJcs } from "./jcs";
import {
  X402_DOMAIN_PREFIX,
  X402_PROFILE_HTTP,
  X402_PROFILE_MCP,
} from "./constants";

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 of `0x01 || value bytes` for a present member, `0x00` for absent. */
function presentHash(bytes: Buffer): string {
  return sha256Hex(Buffer.concat([Buffer.from([0x01]), bytes]));
}
const ABSENT_HASH = sha256Hex(Buffer.from([0x00]));

export interface HttpBindingInput {
  /** HTTP method, case preserved per RFC 9421 @method rules. */
  method: string;
  /** Absolute http(s) URL including query string, no fragment/userinfo. */
  url: string;
  /** Parsed JSON body (hashed as JCS bytes — see header note). */
  bodyJson: unknown;
  /** Present request headers, keyed by lowercase name. */
  headers: Record<string, string | undefined>;
  /** Configured bound header names (lowercase, ascending, unique). */
  boundHeaders: string[];
}

export function computeHttpRequestHash(input: HttpBindingInput): {
  requestHash: string;
  params: { headers: string[] };
} {
  const bodyHash = sha256Hex(canonicalizeJcs(input.bodyJson ?? null));
  const headers = input.boundHeaders.map((name) => {
    const value = input.headers[name];
    return {
      name,
      valueHash:
        value === undefined
          ? ABSENT_HASH
          : presentHash(Buffer.from(value, "latin1")),
    };
  });
  const binding = {
    domain: `${X402_DOMAIN_PREFIX}${X402_PROFILE_HTTP}`,
    method: input.method,
    url: input.url,
    bodyHash,
    headers,
  };
  return {
    requestHash: sha256Hex(canonicalizeJcs(binding)),
    params: { headers: [...input.boundHeaders] },
  };
}

export interface McpBindingInput {
  /** Public MCP endpoint URI from server configuration, never client echo. */
  server: string;
  /** The actual params.name of the tools/call. */
  toolName: string;
  /** The actual params.arguments object; {} when omitted. */
  args: Record<string, unknown>;
  /** params._meta members, keyed by name; undefined when absent. */
  meta?: Record<string, unknown>;
  /** Configured bound _meta member names (JCS property order, unique). */
  boundMetadata: string[];
}

export function computeMcpRequestHash(input: McpBindingInput): {
  requestHash: string;
  params: { server: string; metadata: string[] };
} {
  if (
    !input.args ||
    typeof input.args !== "object" ||
    Array.isArray(input.args)
  ) {
    throw new Error("mcp:1 binding requires an arguments object");
  }
  const metadata = input.boundMetadata.map((name) => {
    const has = input.meta !== undefined && name in input.meta;
    return {
      name,
      valueHash: has
        ? presentHash(
            Buffer.from(canonicalizeJcs((input.meta as any)[name]), "utf8")
          )
        : ABSENT_HASH,
    };
  });
  const binding = {
    domain: `${X402_DOMAIN_PREFIX}${X402_PROFILE_MCP}`,
    server: input.server,
    method: "tools/call",
    name: input.toolName,
    arguments: input.args,
    metadata,
  };
  return {
    requestHash: sha256Hex(canonicalizeJcs(binding)),
    params: { server: input.server, metadata: [...input.boundMetadata] },
  };
}

/** Recompute the request hash for a settling request and compare it against
 * the challenge. Returns true when they match. */
export function requestHashMatches(expected: string, actual: string): boolean {
  return (
    /^[0-9a-f]{64}$/.test(expected) &&
    expected.toLowerCase() === actual.toLowerCase()
  );
}
