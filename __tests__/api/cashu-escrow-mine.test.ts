/**
 * Route coverage for GET /api/cashu/escrow/mine — the buyer-authenticated
 * (NIP-98) escrow rediscovery endpoint. A buyer who wiped their browser after
 * a refund payout loses the escrowId that is the only handle to the
 * server-held payout; this endpoint is how the wallet page finds it again.
 *
 * Critical contract: a DB outage must return 500, never an empty 200 — a
 * wiped buyer would read "no escrows" as "nothing to recover".
 */
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/cashu/escrow/mine";
import { applyRateLimit } from "@/utils/rate-limit";
import { isEscrowEnabled } from "@/utils/cashu/escrow-config";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { listEscrowRegistrationsByBuyer } from "@/utils/db/cashu-escrow-service";

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));
jest.mock("@/utils/cashu/escrow-config", () => {
  const actual = jest.requireActual("@/utils/cashu/escrow-config");
  return { ...actual, isEscrowEnabled: jest.fn(() => true) };
});
jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: jest.fn(),
}));
jest.mock("@/utils/db/cashu-escrow-service", () => ({
  listEscrowRegistrationsByBuyer: jest.fn(),
}));

const mockedApplyRateLimit = applyRateLimit as jest.Mock;
const mockedIsEscrowEnabled = isEscrowEnabled as jest.Mock;
const mockedVerify = verifyNip98Request as jest.Mock;
const mockedList = listEscrowRegistrationsByBuyer as jest.Mock;

const BUYER_PK = "b".repeat(64);

function makeReqRes(method = "GET") {
  const req = {
    method,
    query: {},
    headers: { authorization: "Nostr abc" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as NextApiRequest;
  const res: any = {
    statusCode: 200,
    body: undefined,
    setHeader: jest.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return {
    req,
    res: res as NextApiResponse & { statusCode: number; body: any },
  };
}

describe("GET /api/cashu/escrow/mine", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedApplyRateLimit.mockResolvedValue(true);
    mockedIsEscrowEnabled.mockReturnValue(true);
    mockedVerify.mockResolvedValue({ ok: true, pubkey: BUYER_PK });
    mockedList.mockResolvedValue([]);
  });

  it("405s non-GET methods", async () => {
    const { req, res } = makeReqRes("POST");
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("403s when escrow is disabled (fail closed)", async () => {
    mockedIsEscrowEnabled.mockReturnValue(false);
    const { req, res } = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("escrow_disabled");
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("401s when the NIP-98 auth event is missing or invalid", async () => {
    mockedVerify.mockResolvedValue({
      ok: false,
      error: "Missing NIP-98 authorization header",
    });
    const { req, res } = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe("unauthorized");
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("lists only the authenticated buyer's escrows, serialized for the client", async () => {
    mockedList.mockResolvedValue([
      {
        escrowId: `${BUYER_PK}:order-1`,
        orderId: "order-1",
        sellerPubkey: "d".repeat(64),
        amountSats: 1234,
        mintUrl: "https://mint.example",
        expiresAt: new Date(1_900_000_000_000),
        createdAt: new Date(1_800_000_000_000),
        status: "refunded",
        pendingAction: null,
        payoutAvailable: true,
      },
    ]);
    const { req, res } = makeReqRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    // The DB accessor is scoped by the AUTHENTICATED pubkey, never a query
    // parameter — a buyer can only ever list their own escrows.
    expect(mockedList).toHaveBeenCalledWith(BUYER_PK);
    expect(res.body.escrows).toEqual([
      {
        escrowId: `${BUYER_PK}:order-1`,
        orderId: "order-1",
        sellerPubkey: "d".repeat(64),
        amountSats: 1234,
        mintUrl: "https://mint.example",
        expiresAt: 1_900_000_000,
        createdAt: 1_800_000_000,
        status: "refunded",
        pendingAction: null,
        payoutAvailable: true,
      },
    ]);
  });

  it("500s on a DB outage instead of masquerading as an empty list", async () => {
    mockedList.mockRejectedValue(new Error("connection terminated"));
    const { req, res } = makeReqRes();
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe("internal_error");
    err.mockRestore();
  });

  it("stops at the rate limit without hitting the DB", async () => {
    mockedApplyRateLimit.mockResolvedValue(false);
    const { req, res } = makeReqRes();
    await handler(req, res);
    expect(mockedVerify).not.toHaveBeenCalled();
    expect(mockedList).not.toHaveBeenCalled();
  });
});
