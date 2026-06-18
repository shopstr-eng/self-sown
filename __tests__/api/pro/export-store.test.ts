/** @jest-environment node */

// Endpoint gating for the Wrangler self-host export. Both gates are required:
//   1. a valid signed Nostr request proof bound to the caller's pubkey, and
//   2. that pubkey being a LIFETIME (Wrangler) member.
// We run the REAL bundle + zip builders so a 200 proves a genuine ZIP is sent,
// and mock only the auth + membership leaves so we can drive each gate.

const applyRateLimitMock = jest.fn();
const verifyProofMock = jest.fn();
const extractSignedEventMock = jest.fn();
const getMembershipViewMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/nostr/request-auth", () => {
  const actual = jest.requireActual("@/utils/nostr/request-auth");
  return {
    ...actual,
    extractSignedEventFromRequest: (...args: unknown[]) =>
      extractSignedEventMock(...args),
    verifySignedHttpRequestProof: (...args: unknown[]) =>
      verifyProofMock(...args),
  };
});

jest.mock("@/utils/pro/membership", () => ({
  getMembershipView: (...args: unknown[]) => getMembershipViewMock(...args),
}));

import handler from "@/pages/api/pro/export-store";

const PUBKEY = "a".repeat(64);

function makeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
  };
  return res;
}

describe("POST /api/pro/export-store", () => {
  beforeEach(() => {
    applyRateLimitMock.mockReset().mockReturnValue(true);
    verifyProofMock.mockReset().mockReturnValue({ ok: true, status: 200 });
    extractSignedEventMock.mockReset().mockReturnValue({ id: "evt" });
    getMembershipViewMock.mockReset();
  });

  it("rejects non-POST methods", async () => {
    const res = makeRes();
    await handler({ method: "GET" } as any, res as any);
    expect(res.statusCode).toBe(405);
  });

  it("rejects a missing pubkey", async () => {
    const res = makeRes();
    await handler({ method: "POST", body: {} } as any, res as any);
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid signed proof", async () => {
    verifyProofMock.mockReturnValue({
      ok: false,
      status: 401,
      error: "Invalid signed request proof or pubkey mismatch.",
    });
    const res = makeRes();
    await handler(
      { method: "POST", body: { pubkey: PUBKEY } } as any,
      res as any
    );
    expect(res.statusCode).toBe(401);
    expect(getMembershipViewMock).not.toHaveBeenCalled();
  });

  it("rejects a non-lifetime (recurring Pro) member with 403", async () => {
    getMembershipViewMock.mockResolvedValue({ isLifetime: false });
    const res = makeRes();
    await handler(
      { method: "POST", body: { pubkey: PUBKEY, slug: "my-farm" } } as any,
      res as any
    );
    expect(res.statusCode).toBe(403);
    expect(String((res.body as any).error).toLowerCase()).toContain("wrangler");
  });

  it("streams a ZIP for a lifetime (Wrangler) member", async () => {
    getMembershipViewMock.mockResolvedValue({ isLifetime: true });
    const res = makeRes();
    await handler(
      {
        method: "POST",
        body: {
          pubkey: PUBKEY,
          slug: "my-farm",
          relays: ["wss://relay.example"],
        },
      } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/zip");
    expect(res.headers["Content-Disposition"]).toContain(
      "milk-market-self-host-my-farm.zip"
    );
    expect(Buffer.isBuffer(res.body)).toBe(true);
    // Real ZIP: starts with the local file header signature PK\x03\x04.
    expect((res.body as Buffer).slice(0, 4).toString("hex")).toBe("504b0304");
  });
});
