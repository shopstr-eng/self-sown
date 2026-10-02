// Regression guard for the x402 guarded mint transport
// (utils/x402/guarded-mint-request.ts) against the INSTALLED @cashu/cashu-ts.
//
// The fault tests in x402-tools.test.ts mock the whole SDK, so an upgrade
// that drifts the wire contract — Amount serialization, JSONInt semantics,
// or the MintOperationError/HttpResponseError error classes wallet internals
// branch on — would pass CI and break live payments. These tests construct
// REAL SDK Amount objects and run them through the real adapter code, mocking
// only safeFetch (the network boundary), so any such drift fails loudly here.

import {
  Amount,
  HttpResponseError,
  isMintOperationError,
  JSONInt,
  MintOperationError,
} from "@cashu/cashu-ts";
import { createGuardedMintRequest } from "@/utils/x402/guarded-mint-request";

const mockSafeFetch = jest.fn();
jest.mock("@/utils/url-safety", () => {
  const actual = jest.requireActual("@/utils/url-safety");
  return {
    ...actual,
    safeFetch: (...args: any[]) => mockSafeFetch(...args),
  };
});

const sdk = { JSONInt, HttpResponseError, MintOperationError };

function fakeResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function lastCallBody(): string {
  const init = mockSafeFetch.mock.calls.at(-1)?.[1];
  expect(typeof init?.body).toBe("string");
  return init.body as string;
}

beforeEach(() => {
  mockSafeFetch.mockReset();
});

describe("guarded mint request — SDK wire-format contract", () => {
  it("serializes real SDK Amount fields as unquoted numbers in request bodies", async () => {
    // Premise the whole adapter rests on: plain JSON.stringify must STILL
    // quote Amount fields (Amount.toJSON() returns a string). If a future
    // SDK changes this, this assertion flips and tells us to revisit the
    // adapter rather than discovering it via mint rejections.
    const amount = Amount.from(21);
    expect(JSON.stringify({ amount })).toBe('{"amount":"21"}');

    mockSafeFetch.mockResolvedValueOnce(fakeResponse(200, "{}"));
    const request = createGuardedMintRequest(sdk);
    await request({
      endpoint: "https://mint.example/v1/melt/bolt11",
      requestBody: {
        quote: "q1",
        amount: Amount.from(21),
        // Beyond Number.MAX_SAFE_INTEGER: plain JSON/number coercion would
        // silently corrupt this; JSONInt must emit it exactly, unquoted.
        fee_reserve: Amount.from("9007199254740993"),
        unit: "sat",
      },
    });

    const body = lastCallBody();
    expect(body).toContain('"amount":21');
    expect(body).toContain('"fee_reserve":9007199254740993');
    expect(body).toContain('"unit":"sat"');
    expect(body).not.toContain('"21"');
    expect(body).not.toContain('"9007199254740993"');
    // And the body must round-trip through the SDK's own parser with the
    // big amount intact — the same fidelity the mint applies.
    const roundTripped = JSONInt.parse(body) as {
      amount: unknown;
      fee_reserve: unknown;
    };
    expect(roundTripped.amount).toBe(21);
    expect(roundTripped.fee_reserve).toBe(9007199254740993n);
  });

  it("parses mint responses with JSONInt semantics (bigint fidelity)", async () => {
    // JSON.parse would silently round 9007199254740993 to ...992; the melt
    // quote amount/fee_reserve must survive exactly or the spend-cap check
    // in the tool operates on corrupted numbers.
    mockSafeFetch.mockResolvedValueOnce(
      fakeResponse(200, '{"quote":"q1","amount":9007199254740993,"fee_reserve":2}')
    );
    const request = createGuardedMintRequest(sdk);
    const json = await request<any>({
      endpoint: "https://mint.example/v1/melt/quote/bolt11",
      method: "POST",
      requestBody: { request: "lnbc...", unit: "sat" },
    });
    expect(json.amount).toBe(9007199254740993n);
    expect(json.fee_reserve).toBe(2);
  });

  it("maps {code, detail} error bodies to the SDK's MintOperationError", async () => {
    mockSafeFetch.mockResolvedValueOnce(
      fakeResponse(400, '{"code":20001,"detail":"quote expired"}')
    );
    const request = createGuardedMintRequest(sdk);
    const err = await request({
      endpoint: "https://mint.example/v1/melt/bolt11",
      requestBody: { quote: "q1" },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MintOperationError);
    expect((err as any).code).toBe(20001);
    expect((err as Error).message).toBe("quote expired");
    // Wallet internals branch on the SDK's own type guard (eg the NUT-20
    // legacy-signature retry) — the thrown error must satisfy it.
    expect(isMintOperationError(err)).toBe(true);
  });

  it("falls back to a synthesized detail when a mint error omits it", async () => {
    mockSafeFetch.mockResolvedValueOnce(fakeResponse(400, '{"code":11001}'));
    const request = createGuardedMintRequest(sdk);
    const err = await request({
      endpoint: "https://mint.example/v1/melt/bolt11",
      requestBody: { quote: "q1" },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MintOperationError);
    expect((err as any).code).toBe(11001);
    expect((err as Error).message).toBe("Mint error 11001");
  });

  it("maps non-protocol failures to HttpResponseError with the status", async () => {
    mockSafeFetch.mockResolvedValueOnce(
      fakeResponse(500, '{"detail":"internal boom"}')
    );
    const request = createGuardedMintRequest(sdk);
    const err = await request({
      endpoint: "https://mint.example/v1/melt/bolt11",
      requestBody: { quote: "q1" },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpResponseError);
    expect(isMintOperationError(err)).toBe(false);
    expect((err as any).status).toBe(500);
    expect((err as Error).message).toBe("internal boom");
  });

  it("rejects non-JSON mint responses as HttpResponseError, even on 2xx", async () => {
    const request = createGuardedMintRequest(sdk);
    for (const status of [200, 502]) {
      mockSafeFetch.mockResolvedValueOnce(fakeResponse(status, "<html>bad gateway</html>"));
      const err = await request({
        endpoint: "https://mint.example/v1/melt/quote/bolt11/q1",
        method: "GET",
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpResponseError);
      expect((err as any).status).toBe(status);
      expect((err as Error).message).toContain("non-JSON");
    }
  });

  it("keeps the SSRF-safe fetch posture on every call", async () => {
    mockSafeFetch.mockResolvedValue(fakeResponse(200, "{}"));
    const request = createGuardedMintRequest(sdk);

    await request({
      endpoint: "https://mint.example/v1/melt/bolt11",
      requestBody: { quote: "q1" },
      headers: { authorization: "Bearer t" },
    });
    let init = mockSafeFetch.mock.calls.at(-1)?.[1];
    expect(init.method).toBe("POST");
    expect(init.followRedirects).toBe(false);
    expect(init.accept).toBe("application/json");
    expect(init.timeoutMs).toBe(20000);
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer t",
    });

    await request({ endpoint: "https://mint.example/v1/info" });
    init = mockSafeFetch.mock.calls.at(-1)?.[1];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });
});
