// Unit tests for the x402 `exact`/`lnbtc` protocol core: JCS canonicalization
// (RFC 8785 vectors), request binding, BOLT11 decoding against a real signed
// invoice fixture, header codecs, and payment-payload validation.
//
// The fixture invoice below is a REAL signed bolt11 invoice generated with
// the bolt11 library (test key, 25 sats, description hash, 1h expiry) — its
// preimage is known, which lets the full preimage→payment-hash proof path be
// exercised offline.

import { canonicalizeJcs } from "../jcs";
import {
  computeHttpRequestHash,
  computeMcpRequestHash,
  requestHashMatches,
} from "../request-binding";
import { decodeBolt11, Bolt11DecodeError } from "../bolt11";
import { buildLnBtcRequirement, validatePaymentPayload } from "../server";
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  decodeSettlementHeader,
  encodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  encodeSettlementHeader,
  type X402PaymentPayload,
} from "../types";
import {
  X402_ASSET_BTC,
  X402_LNBTC_MAINNET,
  X402_SCHEME_EXACT,
} from "../constants";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Fixture: real signed invoice, 25 sats, description hash bound, 3600s expiry
// ---------------------------------------------------------------------------
const FIXTURE = {
  invoice:
    "lnbc250n1p4ta2gqpp5fwcxlrjw8fm3t5sp64eap2jzxa3w2hdt6cdzcq3837jke3kjjnsqhp5nl3vhw262vvaccprhdszgtjsvfcsjxkwx696y00axeflclqqz08qxqrrsscqpfuv50sphk9dnjypn94zwxapu6w7ren0n30dm36gr5seuqz8786uh5856y9ypr4tadlmgsr5dn2fpymvzuaxvm7jfuum7xm9462zx5hcgqqdxmwz",
  preimage: "0707070707070707070707070707070707070707070707070707070707070707",
  paymentHash:
    "4bb06f8e4e3a7715d201d573d0aa423762e55dabd61a2c02278fa56cc6d294e0",
  descriptionHash:
    "9fe2cbb95a5319dc6023bb60242e506271091ace368ba23dfd3653fc7c0013ce",
  payeeNodeKey:
    "03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad",
  amountMsat: 25000n,
  expirySeconds: 3600,
  timestamp: 1790880000,
};

describe("canonicalizeJcs (RFC 8785)", () => {
  test("sorts object keys", () => {
    expect(canonicalizeJcs({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  test("number serialization: no plus, no leading zeros, shortest form", () => {
    expect(canonicalizeJcs(1e30)).toBe("1e+30");
    expect(canonicalizeJcs(0.1)).toBe("0.1");
    expect(canonicalizeJcs(-0)).toBe("0");
  });
  test("RFC 8785 fractional example", () => {
    // Appendix-style vector: shortest round-trip form.
    expect(canonicalizeJcs(333333333.33333329)).toBe("333333333.3333333");
  });
  test("strings escape control chars, keep unicode raw", () => {
    expect(canonicalizeJcs("€")).toBe('"€"');
    expect(canonicalizeJcs("a\nb")).toBe('"a\\nb"');
  });
  test("arrays and null", () => {
    expect(canonicalizeJcs([1, "two", null, true])).toBe('[1,"two",null,true]');
  });
  test("rejects undefined and functions", () => {
    expect(() => canonicalizeJcs(undefined)).toThrow();
    expect(() => canonicalizeJcs({ a: () => 1 })).toThrow();
  });
  test("rejects non-finite numbers", () => {
    expect(() => canonicalizeJcs(NaN)).toThrow();
    expect(() => canonicalizeJcs(Infinity)).toThrow();
  });
});

describe("request binding", () => {
  test("http:1 is deterministic and domain-separated", () => {
    const input = {
      method: "POST",
      url: "https://selfsown.com/api/mcp/create-order",
      bodyJson: { bar: "two", foo: 1 },
      headers: {
        authorization: "Bearer abc",
        "content-type": "application/json",
      },
      boundHeaders: ["authorization", "content-type"],
    };
    const a = computeHttpRequestHash(input);
    const b = computeHttpRequestHash({
      ...input,
      bodyJson: { foo: 1, bar: "two" }, // key order must not matter (JCS)
    });
    expect(a.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.requestHash).toBe(b.requestHash);
    expect(a.params).toEqual({ headers: ["authorization", "content-type"] });
  });

  test("http:1 distinguishes present vs absent bound headers", () => {
    const base = {
      method: "POST",
      url: "https://selfsown.com/api/mcp/create-order",
      bodyJson: { productId: "p1" },
      headers: { authorization: "Bearer abc" } as Record<
        string,
        string | undefined
      >,
      boundHeaders: ["authorization", "content-type"],
    };
    const withAuth = computeHttpRequestHash(base);
    const withoutAuth = computeHttpRequestHash({
      ...base,
      headers: {},
    });
    expect(withAuth.requestHash).not.toBe(withoutAuth.requestHash);
  });

  test("mcp:1 binds server, tool name, and arguments", () => {
    const a = computeMcpRequestHash({
      server: "https://selfsown.com/api/mcp",
      toolName: "create_order",
      args: { productId: "p1", quantity: 2 },
      boundMetadata: [],
    });
    const b = computeMcpRequestHash({
      server: "https://selfsown.com/api/mcp",
      toolName: "create_order",
      args: { productId: "p1", quantity: 2 },
      boundMetadata: [],
    });
    const differentTool = computeMcpRequestHash({
      server: "https://selfsown.com/api/mcp",
      toolName: "pay_x402_request",
      args: { productId: "p1", quantity: 2 },
      boundMetadata: [],
    });
    expect(a.requestHash).toBe(b.requestHash);
    expect(a.requestHash).not.toBe(differentTool.requestHash);
    expect(a.params.server).toBe("https://selfsown.com/api/mcp");
  });

  test("mcp:1 rejects non-object arguments", () => {
    expect(() =>
      computeMcpRequestHash({
        server: "https://selfsown.com/api/mcp",
        toolName: "create_order",
        args: [] as any,
        boundMetadata: [],
      })
    ).toThrow();
  });

  test("requestHashMatches validates shape and compares", () => {
    const h = "a".repeat(64);
    expect(requestHashMatches(h, h)).toBe(true);
    expect(requestHashMatches(h, "b".repeat(64))).toBe(false);
    expect(requestHashMatches("not-hex", h)).toBe(false);
  });
});

describe("decodeBolt11", () => {
  test("decodes a real signed invoice (amount, hash, payee, expiry)", () => {
    const d = decodeBolt11(FIXTURE.invoice);
    expect(d.currency).toBe("bc");
    expect(d.amountMsat).toBe(FIXTURE.amountMsat);
    expect(d.paymentHash).toBe(FIXTURE.paymentHash);
    expect(d.payeeNodeKey).toBe(FIXTURE.payeeNodeKey);
    expect(d.expirySeconds).toBe(FIXTURE.expirySeconds);
    expect(d.descriptionHash).toBe(FIXTURE.descriptionHash);
    expect(d.timestamp).toBe(FIXTURE.timestamp);
  });

  test("rejects tampered invoices (bad signature/checksum)", () => {
    const tampered = FIXTURE.invoice.slice(0, -8) + "qqqqqqqq";
    expect(() => decodeBolt11(tampered)).toThrow(Bolt11DecodeError);
  });

  test("rejects non-invoice input", () => {
    expect(() => decodeBolt11("not-an-invoice")).toThrow(Bolt11DecodeError);
  });
});

describe("header codecs", () => {
  test("payment-required round-trips", () => {
    const required = {
      x402Version: 2 as const,
      resource: {
        url: "https://x",
        description: "d",
        mimeType: "application/json",
      },
      accepts: [],
    };
    const encoded = encodePaymentRequiredHeader(required as any);
    expect(decodePaymentRequiredHeader(encoded)).toBeNull(); // empty accepts
    const withAccepts = {
      ...required,
      accepts: [{ scheme: "exact" }],
    };
    const decoded = decodePaymentRequiredHeader(
      encodePaymentRequiredHeader(withAccepts as any)
    );
    expect(decoded?.x402Version).toBe(2);
  });

  test("payment-signature round-trips and tolerates base64url", () => {
    const payload = {
      x402Version: 2,
      accepted: {},
      payload: { preimage: "ab" },
    };
    const encoded = encodePaymentSignatureHeader(payload as any);
    const asUrlSafe = encoded.replace(/\+/g, "-").replace(/\//g, "_");
    expect(decodePaymentSignatureHeader(asUrlSafe)?.x402Version).toBe(2);
    expect(decodePaymentSignatureHeader("!!!not-base64!!!")).toBeNull();
  });

  test("settlement round-trips", () => {
    const settlement = {
      success: true,
      transaction: "a".repeat(64),
      network: X402_LNBTC_MAINNET,
    };
    expect(decodeSettlementHeader(encodeSettlementHeader(settlement))).toEqual(
      settlement
    );
  });
});

describe("buildLnBtcRequirement", () => {
  const context = {
    requestHash: FIXTURE.descriptionHash,
    profile: "http:1" as const,
    profileParams: { headers: ["authorization", "content-type"] },
    resourceUrl: "https://selfsown.com/api/mcp/create-order",
    description: "test",
  };

  test("builds a spec-shaped requirement from a real invoice", () => {
    const req = buildLnBtcRequirement({
      amountSats: 25,
      invoice: FIXTURE.invoice,
      context,
      maxTimeoutSeconds: 3600,
    });
    expect(req.scheme).toBe(X402_SCHEME_EXACT);
    expect(req.network).toBe(X402_LNBTC_MAINNET);
    expect(req.asset).toBe(X402_ASSET_BTC);
    expect(req.amount).toBe("25000");
    expect(req.payTo).toBe(FIXTURE.payeeNodeKey);
    expect(req.maxTimeoutSeconds).toBe(3600);
    expect(req.extra.invoice).toBe(FIXTURE.invoice);
    expect(req.extra.requestHash).toBe(FIXTURE.descriptionHash);
    expect(req.extra.paymentFlow).toBe("upfront");
  });

  test("fails closed when invoice amount does not match the charge", () => {
    expect(() =>
      buildLnBtcRequirement({
        amountSats: 26,
        invoice: FIXTURE.invoice,
        context,
        maxTimeoutSeconds: 3600,
      })
    ).toThrow();
  });
});

describe("validatePaymentPayload", () => {
  function makePayload(
    overrides: Partial<X402PaymentPayload> = {}
  ): X402PaymentPayload {
    const requirement = buildLnBtcRequirement({
      amountSats: 25,
      invoice: FIXTURE.invoice,
      context: {
        requestHash: FIXTURE.descriptionHash,
        profile: "http:1",
        profileParams: { headers: [] },
        resourceUrl: "https://selfsown.com/api/mcp/create-order",
        description: "test",
      },
      maxTimeoutSeconds: 3600,
    });
    return {
      x402Version: 2,
      accepted: requirement,
      payload: { preimage: FIXTURE.preimage },
      ...overrides,
    };
  }

  const base = {
    expectedAmountMsat: FIXTURE.amountMsat,
    expectedRequestHash: FIXTURE.descriptionHash,
    strictBinding: true,
  };

  test("accepts the correct preimage (strict binding)", () => {
    const result = validatePaymentPayload({
      payload: makePayload(),
      ...base,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paymentHash).toBe(FIXTURE.paymentHash);
      expect(result.amountMsat).toBe(FIXTURE.amountMsat);
    }
  });

  test("rejects a wrong preimage", () => {
    const wrong = createHash("sha256").update("nope").digest("hex");
    const result = validatePaymentPayload({
      payload: makePayload({ payload: { preimage: wrong } }),
      ...base,
    });
    expect(result).toEqual({ ok: false, reason: "preimage_mismatch" });
  });

  test("rejects wrong expected amount", () => {
    const result = validatePaymentPayload({
      payload: makePayload(),
      ...base,
      expectedAmountMsat: 26000n,
    });
    expect(result).toEqual({ ok: false, reason: "amount_mismatch" });
  });

  test("rejects a tampered accepted amount", () => {
    const payload = makePayload();
    const tampered = {
      ...payload,
      accepted: { ...payload.accepted, amount: "26000" },
    };
    const result = validatePaymentPayload({
      payload: tampered,
      ...base,
      expectedAmountMsat: 26000n,
    });
    expect(result).toEqual({ ok: false, reason: "invoice_amount_mismatch" });
  });

  test("strict binding rejects a wrong request hash", () => {
    const result = validatePaymentPayload({
      payload: makePayload(),
      ...base,
      expectedRequestHash: "0".repeat(64),
    });
    expect(result).toEqual({ ok: false, reason: "request_binding_mismatch" });
  });

  test("relaxed binding skips the invoice description-hash check", () => {
    const result = validatePaymentPayload({
      payload: makePayload(),
      expectedAmountMsat: FIXTURE.amountMsat,
      expectedRequestHash: "0".repeat(64), // different from the invoice's hash
      strictBinding: false,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects non-mainnet network in the payload", () => {
    const payload = makePayload();
    const tampered = {
      ...payload,
      accepted: { ...payload.accepted, network: "lnbtc:testnet" },
    };
    const result = validatePaymentPayload({ payload: tampered, ...base });
    expect(result).toEqual({ ok: false, reason: "unsupported_network" });
  });

  test("rejects a malformed preimage", () => {
    const result = validatePaymentPayload({
      payload: makePayload({ payload: { preimage: "xyz" } }),
      ...base,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_preimage_format" });
  });
});
