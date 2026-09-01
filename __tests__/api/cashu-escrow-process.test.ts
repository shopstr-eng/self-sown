import type { NextApiRequest, NextApiResponse } from "next";
import handler from "@/pages/api/cashu/escrow/process";
import { applyRateLimit } from "@/utils/rate-limit";
import { runEscrowPayoutSweep } from "@/utils/cashu/escrow-payout-worker";

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));
jest.mock("@/utils/cashu/escrow-payout-worker", () => ({
  ESCROW_PAYOUT_BATCH_SIZE: 10,
  runEscrowPayoutSweep: jest.fn(),
}));

const mockedApplyRateLimit = applyRateLimit as jest.Mock;
const mockedSweep = runEscrowPayoutSweep as jest.Mock;

const SECRET = "test-processor-secret";
const ORIGINAL_SECRET = process.env.FLOW_PROCESSOR_SECRET;

function makeReqRes(options: {
  method?: string;
  body?: any;
  secretHeader?: string;
}) {
  const req = {
    method: options.method ?? "POST",
    body: options.body ?? {},
    headers: options.secretHeader
      ? { "x-flow-processor-secret": options.secretHeader }
      : {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as NextApiRequest;
  const res: any = {
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
  };
  return {
    req,
    res: res as NextApiResponse & { statusCode: number; body: any },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.FLOW_PROCESSOR_SECRET = SECRET;
  mockedSweep.mockResolvedValue({
    skipped: false,
    recovered: 0,
    expiredFound: 0,
    refundsEnqueued: 0,
    processed: 0,
    failed: [],
  });
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.FLOW_PROCESSOR_SECRET;
  } else {
    process.env.FLOW_PROCESSOR_SECRET = ORIGINAL_SECRET;
  }
});

describe("POST /api/cashu/escrow/process", () => {
  it("rejects non-POST methods", async () => {
    const { req, res } = makeReqRes({ method: "GET" });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("rejects callers without the processor secret", async () => {
    const { req, res } = makeReqRes({});
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(mockedSweep).not.toHaveBeenCalled();

    const wrong = makeReqRes({ secretHeader: "nope" });
    await handler(wrong.req, wrong.res);
    expect(wrong.res.statusCode).toBe(401);
    expect(mockedSweep).not.toHaveBeenCalled();
  });

  it("fails closed when the processor secret is not configured", async () => {
    delete process.env.FLOW_PROCESSOR_SECRET;
    const { req, res } = makeReqRes({ secretHeader: SECRET });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(mockedSweep).not.toHaveBeenCalled();
  });

  it("never runs the sweep when rate limited", async () => {
    mockedApplyRateLimit.mockResolvedValueOnce(false);
    const { req, res } = makeReqRes({ secretHeader: SECRET });
    await handler(req, res);
    expect(mockedSweep).not.toHaveBeenCalled();
  });

  it("runs the payout sweep and returns the summary", async () => {
    const { req, res } = makeReqRes({ secretHeader: SECRET });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockedSweep).toHaveBeenCalledWith({ batchSize: 10 });
  });

  it("accepts and clamps batch_size", async () => {
    const { req, res } = makeReqRes({
      secretHeader: SECRET,
      body: { batch_size: 5000 },
    });
    await handler(req, res);
    expect(mockedSweep).toHaveBeenCalledWith({ batchSize: 100 });
  });

  it("returns 500 when the sweep throws", async () => {
    mockedSweep.mockRejectedValueOnce(new Error("db down"));
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();
    const { req, res } = makeReqRes({ secretHeader: SECRET });
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("db down");
    consoleSpy.mockRestore();
  });
});
