/** @jest-environment node */

// Host-aware Apple Pay domain-association routing: the platform marketplace
// host must 404 (Apple Pay disabled there); verified custom domains get the
// file matching the seller's connected processor; unknown hosts (self-host,
// pre-verification) keep the legacy Stripe behavior.

import handler from "@/pages/api/.well-known/apple-developer-merchantid-domain-association";
import { getDomainByHost } from "@/utils/db/custom-domains";
import { hasSquareConnection } from "@/utils/db/square-service";

jest.mock("@/utils/db/custom-domains", () => ({ getDomainByHost: jest.fn() }));
jest.mock("@/utils/db/square-service", () => ({
  hasSquareConnection: jest.fn(),
}));

const getDomainByHostMock = getDomainByHost as jest.Mock;
const hasSquareConnectionMock = hasSquareConnection as jest.Mock;

const STRIPE_FILE = "stripe-association-body";
const SQUARE_FILE = "square-association-body";
const PLATFORM_HOST = "self-sown.com";

function makeReq(host?: string) {
  return { headers: host ? { host } : {} } as any;
}

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    send: jest.fn(),
    end: jest.fn(),
    setHeader: jest.fn(),
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_BASE_URL = `https://${PLATFORM_HOST}`;
  process.env.APPLE_PAY_DOMAIN_ASSOCIATION = STRIPE_FILE;
  process.env.SQUARE_APPLE_PAY_DOMAIN_ASSOCIATION = SQUARE_FILE;
  getDomainByHostMock.mockResolvedValue(null);
  hasSquareConnectionMock.mockResolvedValue(false);
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_BASE_URL;
  delete process.env.APPLE_PAY_DOMAIN_ASSOCIATION;
  delete process.env.SQUARE_APPLE_PAY_DOMAIN_ASSOCIATION;
});

describe("apple-developer-merchantid-domain-association", () => {
  it("404s on the platform marketplace host even with both files set", async () => {
    const res = makeRes();
    await handler(makeReq(PLATFORM_HOST), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.send).not.toHaveBeenCalled();
  });

  it("404s with no host header", async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("serves the Square file on a verified custom domain whose seller is Square-connected", async () => {
    getDomainByHostMock.mockResolvedValue({
      verified: true,
      pubkey: "seller-pubkey",
    });
    hasSquareConnectionMock.mockResolvedValue(true);
    const res = makeRes();
    await handler(makeReq("shop.example.com"), res);
    expect(hasSquareConnectionMock).toHaveBeenCalledWith("seller-pubkey");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(SQUARE_FILE);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/plain");
  });

  it("serves the Stripe file on a verified custom domain whose seller is not Square-connected", async () => {
    getDomainByHostMock.mockResolvedValue({
      verified: true,
      pubkey: "seller-pubkey",
    });
    const res = makeRes();
    await handler(makeReq("shop.example.com"), res);
    expect(res.send).toHaveBeenCalledWith(STRIPE_FILE);
  });

  it("404s on a verified Square-seller domain when the Square file is not configured", async () => {
    delete process.env.SQUARE_APPLE_PAY_DOMAIN_ASSOCIATION;
    getDomainByHostMock.mockResolvedValue({
      verified: true,
      pubkey: "seller-pubkey",
    });
    hasSquareConnectionMock.mockResolvedValue(true);
    const res = makeRes();
    await handler(makeReq("shop.example.com"), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("keeps the legacy Stripe file for unknown hosts (self-host / pre-verification)", async () => {
    const res = makeRes();
    await handler(makeReq("selfhosted.example.org"), res);
    expect(res.send).toHaveBeenCalledWith(STRIPE_FILE);
  });

  it("falls back to the Square file on unknown hosts when only it is set", async () => {
    delete process.env.APPLE_PAY_DOMAIN_ASSOCIATION;
    const res = makeRes();
    await handler(makeReq("selfhosted.example.org"), res);
    expect(res.send).toHaveBeenCalledWith(SQUARE_FILE);
  });

  it("serves the legacy Stripe file when the domain lookup throws", async () => {
    getDomainByHostMock.mockRejectedValue(new Error("db down"));
    const res = makeRes();
    await handler(makeReq("shop.example.com"), res);
    expect(res.send).toHaveBeenCalledWith(STRIPE_FILE);
  });

  it("404s when no association file is configured at all", async () => {
    delete process.env.APPLE_PAY_DOMAIN_ASSOCIATION;
    delete process.env.SQUARE_APPLE_PAY_DOMAIN_ASSOCIATION;
    const res = makeRes();
    await handler(makeReq("selfhosted.example.org"), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
