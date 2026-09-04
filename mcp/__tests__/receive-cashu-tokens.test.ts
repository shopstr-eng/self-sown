/** @jest-environment node */

// Coverage for the receive_cashu_tokens MCP tool (mcp/tools/write-tools.ts).
//
// WHY THIS EXISTS
// The tool decodes a caller-supplied Cashu token server-side. cashu-ts v4's
// getDecodedToken(token, []) throws "A short keyset ID v2 was encountered" for
// tokens from Nutshell >= 0.20 mints, so the tool routes through
// decodeTokenWithKeysets, which fetches the mint's /v1/keysets (SSRF-guarded)
// and retries. A mocked-decode test would never catch that drift.

import { getEncodedToken, type Proof } from "@cashu/cashu-ts";

// --- Mocks -----------------------------------------------------------------

// register-tool wraps every handler in the audit wrapper; pass through.
jest.mock("@/mcp/audit-log", () => ({
  wrapWithAudit: (_name: string, cb: unknown) => cb,
  sanitizeParams: (p: unknown) => p,
  logToolCall: jest.fn(),
}));

const mockSignAndPublishEvent = jest.fn(
  async (_signer: unknown, template: { kind: number }) => ({
    id: "published-event-id",
    ...template,
  })
);
jest.mock("@/utils/mcp/nostr-signing", () => ({
  signAndPublishEvent: (...args: unknown[]) =>
    mockSignAndPublishEvent(...(args as [unknown, { kind: number }])),
  McpNostrSigner: class {},
  McpRelayManager: class {},
}));

const fakeSigner = {
  getPubKey: () => "ab".repeat(32),
  encrypt: jest.fn((_pk: string, data: string) => `enc:${data}`),
};
jest.mock("@/utils/mcp/auth", () => ({
  getAgentSigner: jest.fn(async () => ({ signer: fakeSigner })),
}));

// Module-scope imports only; the receive path calls none of these, but the
// real db-service must never load in jest (pg pool).
jest.mock(
  "@/utils/db/db-service",
  () => new Proxy({}, { get: () => jest.fn() })
);
jest.mock("@/utils/db/inventory-service", () => ({ setStock: jest.fn() }));

jest.mock("@/utils/nostr/nostr-helper-functions", () => ({
  getDefaultRelays: () => ["wss://relay.example"],
  withBlastr: (relays: string[]) => relays,
}));

// token-decode fetches keysets through safeFetch server-side; passthrough so
// the fetch spy below controls responses.
jest.mock("@/utils/url-safety", () => ({
  safeFetch: (url: string) => fetch(url),
}));

// --- Handler capture ---------------------------------------------------------

import { registerWriteTools } from "../tools/write-tools";

const MINT = "https://mint.example";
const V2_KEYSET_ID = "01" + "ab".repeat(31);

const apiKey = {
  id: 1,
  pubkey: "ab".repeat(32),
  permissions: "full_access",
};

type Handler = (args: { token: string }, extra?: unknown) => Promise<any>;

let handler: Handler;
const realFetch = globalThis.fetch;

beforeAll(() => {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    registerTool: (name: string, _meta: unknown, cb: Handler) =>
      handlers.set(name, cb),
  };
  registerWriteTools(fakeServer as any, apiKey as any);
  const captured = handlers.get("receive_cashu_tokens");
  if (!captured) throw new Error("receive_cashu_tokens was not registered");
  handler = captured;
});

afterEach(() => {
  (globalThis as any).fetch = realFetch;
});

const v2Token = (): string =>
  getEncodedToken({
    mint: MINT,
    unit: "sat",
    proofs: [
      {
        id: V2_KEYSET_ID,
        amount: 100,
        secret: "s".repeat(64),
        C: "02" + "cd".repeat(32),
      } as unknown as Proof,
    ],
  });

const parseResult = (result: any) =>
  JSON.parse(result.content[0].text) as Record<string, unknown>;

describe("receive_cashu_tokens", () => {
  it("receives a v2-keyset token via the keyset-aware decode", async () => {
    const fetchSpy = ((globalThis as any).fetch = jest
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ keysets: [{ id: V2_KEYSET_ID }] }),
      }));

    const result = await handler({ token: v2Token() });
    const body = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(body.success).toBe(true);
    expect(body.amount).toBe(100);
    expect(body.mint).toBe(MINT);
    expect(body.proofCount).toBe(1);
    // The v2 fallback fetched the mint's keyset list.
    expect(fetchSpy).toHaveBeenCalledWith(`${MINT}/v1/keysets`);
    // The proof event (kind 7375) was published with the mint tag.
    expect(mockSignAndPublishEvent).toHaveBeenCalledWith(
      fakeSigner,
      expect.objectContaining({
        kind: 7375,
        tags: expect.arrayContaining([["mint", MINT]]),
      })
    );
  });

  it("returns an error response for a garbage token", async () => {
    const fetchSpy = ((globalThis as any).fetch = jest.fn());
    const result = await handler({ token: "cashuB_garbage" });
    expect(result.isError).toBe(true);
    // A non-keyset decode error must NOT trigger a keyset fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
