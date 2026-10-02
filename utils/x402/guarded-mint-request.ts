// Guarded transport for the Cashu SDK's mint HTTP, used by the x402 buyer
// tool (pay_x402_request). Extracted from mcp/tools/x402-tools.ts so the wire
// contract can be regression-tested against the INSTALLED @cashu/cashu-ts —
// the fault tests mock the SDK, so an upgrade that changes Amount
// serialization or the RequestFn error contract would otherwise pass CI and
// break live payments.
//
// Load-bearing contract (verified by __tests__/mcp/x402-guarded-mint-request.test.ts):
//  - Request bodies MUST be serialized with JSONInt, not JSON: the SDK's
//    Amount.toJSON() emits QUOTED strings, while mints expect numeric
//    amounts on the wire.
//  - Responses MUST be parsed with JSONInt so out-of-range integer amounts
//    survive as bigint instead of being silently rounded by JSON.parse.
//  - Mint protocol errors ({code, detail}) MUST surface as the SDK's
//    MintOperationError — wallet internals branch on isMintOperationError
//    (eg the NUT-20 legacy-signature retry). Everything else maps to
//    HttpResponseError with the HTTP status preserved.

import type {
  HttpResponseError as SdkHttpResponseError,
  JSONIntApi,
  MintOperationError as SdkMintOperationError,
} from "@cashu/cashu-ts";
import { safeFetch } from "@/utils/url-safety";

/** The subset of the @cashu/cashu-ts exports the adapter needs. */
export interface GuardedMintSdk {
  JSONInt: JSONIntApi;
  HttpResponseError: typeof SdkHttpResponseError;
  MintOperationError: typeof SdkMintOperationError;
}

export type GuardedMintRequest = <T>(args: {
  endpoint: string;
  requestBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  method?: string;
}) => Promise<T>;

function serializeBody(
  JSONInt: JSONIntApi,
  requestBody: Record<string, unknown>
): string {
  const body = JSONInt.stringify(requestBody);
  // stringify returns undefined only for top-level values JSON cannot
  // represent (matching JSON.stringify); a present requestBody must always
  // serialize, so treat anything else as a hard failure rather than sending
  // a bodyless request the mint would misread.
  if (typeof body !== "string") {
    throw new Error("Failed to serialize Cashu mint request body");
  }
  return body;
}

/**
 * Build the SDK `customRequest` transport. SSRF guard: every mint call is
 * routed through safeFetch, which re-resolves and pins the destination IP per
 * hop (DNS-rebinding safe) and never follows redirects into unvalidated
 * hosts — the SDK's own fetch resolves DNS itself, so a pre-check on the mint
 * URL alone would be bypassable.
 */
export function createGuardedMintRequest(
  sdk: GuardedMintSdk
): GuardedMintRequest {
  const { JSONInt, HttpResponseError, MintOperationError } = sdk;
  return async function guardedMintRequest<T>(args: {
    endpoint: string;
    requestBody?: Record<string, unknown>;
    headers?: Record<string, string>;
    method?: string;
  }): Promise<T> {
    const response = await safeFetch(args.endpoint, {
      method: args.method ?? (args.requestBody ? "POST" : "GET"),
      headers: {
        "content-type": "application/json",
        ...(args.headers ?? {}),
      },
      // JSONInt, not JSON: Cashu Amount.toJSON() emits QUOTED strings,
      // while the wire protocol expects numeric amounts — the SDK's own
      // transport uses JSONInt for exactly this reason.
      ...(args.requestBody
        ? { body: serializeBody(JSONInt, args.requestBody) }
        : {}),
      accept: "application/json",
      followRedirects: false,
      timeoutMs: 20000,
    });
    const text = await response.text();
    // No initializer: initializing to null would pin control-flow narrowing
    // to null after the try (assignments inside try are discarded at the
    // merge point), making every property access below a `never` error.
    let json: unknown;
    try {
      json = text ? JSONInt.parse(text) : null;
    } catch {
      throw new HttpResponseError(
        `Mint returned non-JSON (${response.status})`,
        response.status
      );
    }
    if (!response.ok) {
      const errBody = json as { code?: unknown; detail?: unknown } | null;
      // Mint protocol errors carry {code, detail} — the SDK's
      // isMintOperationError contract expects MintOperationError.
      if (errBody && typeof errBody.code === "number") {
        throw new MintOperationError(
          errBody.code,
          typeof errBody.detail === "string"
            ? errBody.detail
            : `Mint error ${errBody.code}`
        );
      }
      throw new HttpResponseError(
        (errBody && typeof errBody.detail === "string" && errBody.detail) ||
          `Mint request failed (${response.status})`,
        response.status
      );
    }
    return json as T;
  };
}
