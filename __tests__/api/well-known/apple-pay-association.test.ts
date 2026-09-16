/** @jest-environment node */

// Host-aware Apple Pay domain-association routing. Hosted platform: the
// marketplace host 404s (Apple Pay disabled there by product decision),
// verified custom domains get the file matching the seller's connected
// processor, unknown hosts fail closed (404), DB outages 503 — never a
// wrong-file 200. Self-host instances serve the operator-configured file.

import handler from "@/pages/api/.well-known/apple-developer-merchantid-domain-association";
import { getDomainByHost } from "@/utils/db/custom-domains";
import { hasSquareConnection } from "@/utils/db/square-service";
import { __resetSelfHostConfigCacheForTests } from "@/utils/self-host/config";

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

function enableSelfHost() {
  process.env.SS_SELF_HOST = "1";
  __resetSelfHostConfigCacheForTests();
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SS_SELF_HOST;
  delete process.env.MM_SELF_HOST;
  __resetSelfHostConfigCacheForTests();
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
  delete process.env.SS_SELF_HOST;
  delete process.env.MM_SELF_HOST;
  __resetSelfHostConfigCacheForTests();
});

describe("hosted platform", () => {
  it("404s on the platform marketplace host even with both files set", async () => {
    const res = makeRes();
    await handler(makeReq(PLATFORM_HOST), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.send).not.toHaveBeenCalled();
  });

  it("404s on the platform host with a trailing dot (FQDN form)", async () => {
    const res = makeRes();
    await handler(makeReq(`${PLATFORM_HOST}.`), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("404s with no host header", async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("fails closed (404) for hosted unknown hosts", async () => {
    const res = makeRes();
    await handler(makeReq("unverified.example.com"), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.send).not.toHaveBeenCalled();
  });

  it("fails closed (404) when the base URL is malformed", async () => {
    process.env.NEXT_PUBLIC_BASE_URL = "not a url";
    const res = makeRes();
    await handler(makeReq(PLATFORM_HOST), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("503s on a domain-lookup outage rather than serving a wrong file", async () => {
    getDomainByHostMock.mockRejectedValue(new Error("db down"));
    const res = makeRes();
    await handler(makeReq("shop.example.com"), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.send).not.toHaveBeenCalled();
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
});

describe("self-host instance", () => {
  it("serves the configured Stripe file on the instance's own domain", async () => {
    enableSelfHost();
    const res = makeRes();
    await handler(makeReq(PLATFORM_HOST), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(STRIPE_FILE);
  });

  it("serves the Square file for Square-only deployments", async () => {
    delete process.env.APPLE_PAY_DOMAIN_ASSOCIATION;
    enableSelfHost();
    const res = makeRes();
    await handler(makeReq("myshop.example.org"), res);
    expect(res.send).toHaveBeenCalledWith(SQUARE_FILE);
  });

  it("404s when the operator configured no file", async () => {
    delete process.env.APPLE_PAY_DOMAIN_ASSOCIATION;
    delete process.env.SQUARE_APPLE_PAY_DOMAIN_ASSOCIATION;
    enableSelfHost();
    const res = makeRes();
    await handler(makeReq("myshop.example.org"), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
