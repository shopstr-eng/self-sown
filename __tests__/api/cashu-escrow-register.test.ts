import type { NextApiRequest, NextApiResponse } from "next";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
} from "nostr-tools";
import handler from "@/pages/api/cashu/escrow/register";
import { applyRateLimit } from "@/utils/rate-limit";
import { isEscrowEnabled } from "@/utils/cashu/escrow-config";
import { verifyEscrowCommitmentEvent } from "@/utils/cashu/escrow-commitment";
import { registerEscrowCommitment } from "@/utils/db/cashu-escrow-service";

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));
jest.mock("@/utils/cashu/escrow-config", () => {
  const actual = jest.requireActual("@/utils/cashu/escrow-config");
  return { ...actual, isEscrowEnabled: jest.fn(() => true) };
});
jest.mock("@/utils/db/cashu-escrow-service", () => ({
  registerEscrowCommitment: jest.fn(),
}));
// Keep the real verifier but allow env-free allowlists via config mock above.
jest.mock("@/utils/cashu/escrow-commitment", () => {
  const actual = jest.requireActual("@/utils/cashu/escrow-commitment");
  return { ...actual, verifyEscrowCommitmentEvent: jest.fn(actual.verifyEscrowCommitmentEvent) };
});

const mockedApplyRateLimit = applyRateLimit as jest.Mock;
const mockedIsEscrowEnabled = isEscrowEnabled as jest.Mock;
const mockedRegister = registerEscrowCommitment as jest.Mock;
const mockedVerify = verifyEscrowCommitmentEvent as jest.Mock;

const MINT = "https://mint.example";
const ARBITER_PK = "c".repeat(64);

function makeReqRes(body?: any, method = "POST") {
  const req = {
    method,
    body,
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 200,
    body: undefined as any,
    setHeader: jest.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  } as unknown as NextApiResponse & { statusCode: number; body: any };
  return { req, res };
}

function validCommitmentEvent(): Event {
  const secret = generateSecretKey();
  const now = Math.floor(Date.now() / 1000);
  const buyerPubkey = getPublicKey(secret);
  const orderId = "order-xyz";
  const amountSats = 10_000;
  const expiresAt = now + 3600;
  const sellerPubkey = "d".repeat(64);
  const escrowId = `${buyerPubkey}:${orderId}`;
  const content = JSON.stringify({
    amountSats,
    arbiterPubkey: ARBITER_PK,
    expiresAt,
    mintUrl: MINT,
    orderId,
    sellerPubkey,
  });
  return finalizeEvent(
    {
      kind: 31995,
      created_at: now,
      content,
      tags: [
        ["d", escrowId],
        ["order", orderId],
        ["seller", sellerPubkey],
        ["amount", String(amountSats)],
        ["mint", MINT],
        ["expiration", String(expiresAt)],
        ["arbiter", ARBITER_PK],
      ],
    },
    secret
  );
}

describe("POST /api/cashu/escrow/register", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedIsEscrowEnabled.mockReturnValue(true);
    mockedApplyRateLimit.mockResolvedValue(true);
    // Restore the real verifier after clearAllMocks.
    mockedVerify.mockImplementation(
      jest.requireActual("@/utils/cashu/escrow-commitment")
        .verifyEscrowCommitmentEvent
    );
    process.env.CASHU_ESCROW_ALLOWED_MINTS = MINT;
    process.env.CASHU_ESCROW_ARBITER_PUBKEYS = ARBITER_PK;
  });

  afterEach(() => {
    delete process.env.CASHU_ESCROW_ALLOWED_MINTS;
    delete process.env.CASHU_ESCROW_ARBITER_PUBKEYS;
  });

  it("fails closed when escrow is not enabled", async () => {
    mockedIsEscrowEnabled.mockReturnValue(false);
    const { req, res } = makeReqRes({ commitmentEvent: {} });
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("escrow_disabled");
    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it("rejects non-POST methods", async () => {
    const { req, res } = makeReqRes({}, "GET");
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("stops when the rate limiter rejects", async () => {
    mockedApplyRateLimit.mockResolvedValue(false);
    const { req, res } = makeReqRes({ commitmentEvent: {} });
    await handler(req, res);
    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it("rejects a missing commitment event", async () => {
    const { req, res } = makeReqRes({});
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("invalid_request");
  });

  it("rejects a commitment that fails verification", async () => {
    // Well-formed shape, but wrong kind — fails verification, not parsing.
    const badEvent = {
      id: "0".repeat(64),
      pubkey: "0".repeat(64),
      sig: "0".repeat(128),
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [],
    };
    const { req, res } = makeReqRes({ commitmentEvent: badEvent });
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("invalid_commitment");
    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it("registers a valid commitment and returns 201", async () => {
    mockedRegister.mockResolvedValue({ created: true, escrowId: "e1" });
    const { req, res } = makeReqRes({ commitmentEvent: validCommitmentEvent() });
    await handler(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({
      escrowId: "e1",
      status: "locked",
      replayed: false,
    });
    expect(mockedRegister).toHaveBeenCalledTimes(1);
  });

  it("returns 200 on an idempotent replay", async () => {
    mockedRegister.mockResolvedValue({ created: false, escrowId: "e1" });
    const { req, res } = makeReqRes({ commitmentEvent: validCommitmentEvent() });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.replayed).toBe(true);
  });

  it("maps conflicting terms to a 409", async () => {
    mockedRegister.mockRejectedValue(
      new Error("Escrow registration conflict: terms differ from the original commitment.")
    );
    const { req, res } = makeReqRes({ commitmentEvent: validCommitmentEvent() });
    await handler(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe("escrow_conflict");
  });

  it("returns 500 on unexpected storage failures", async () => {
    mockedRegister.mockRejectedValue(new Error("db down"));
    const { req, res } = makeReqRes({ commitmentEvent: validCommitmentEvent() });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe("internal_error");
  });
});
