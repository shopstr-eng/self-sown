/** @jest-environment node */

// verify-domain reports www.<domain> DNS health alongside apex verification.
// The www check is advisory: it must never block apex verification, but the
// dashboard depends on it to warn loudly when buyers typing
// www.<seller-domain> would hit a DNS dead end before the platform's
// www→apex redirect can run. Only apex domains get a www check —
// www.shop.example.com is not a thing buyers type.

import type { NextApiRequest, NextApiResponse } from "next";

const resolveCnameMock = jest.fn();
const resolve4Mock = jest.fn();
const resolveTxtMock = jest.fn();

// The route promisifies dns.* at module scope, so the mocks must be
// callback-style functions delegating to swappable jest.fns.
jest.mock("dns", () => ({
  resolveCname: (host: string, cb: (e: any, r?: string[]) => void) =>
    resolveCnameMock(host, cb),
  resolve4: (host: string, cb: (e: any, r?: string[]) => void) =>
    resolve4Mock(host, cb),
  resolveTxt: (host: string, cb: (e: any, r?: string[][]) => void) =>
    resolveTxtMock(host, cb),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

const markVerifiedMock = jest.fn(async (_pubkey: string) => {});
const getDomainByPubkeyMock = jest.fn();
jest.mock("@/utils/db/custom-domains", () => ({
  getDomainByPubkey: (pubkey: string) => getDomainByPubkeyMock(pubkey),
  markVerified: (pubkey: string) => markVerifiedMock(pubkey),
}));

jest.mock("@/utils/site-url", () => ({
  SITE_HOST: "self-sown.com",
}));

// PRIMARY_HOST is captured at module load, so pin the env BEFORE require
// (this environment exports a real REPLIT_DEPLOYMENT_HOST).
const ORIGINAL_DEPLOYMENT_HOST = process.env.REPLIT_DEPLOYMENT_HOST;
process.env.REPLIT_DEPLOYMENT_HOST = "self-sown.com";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require("@/pages/api/storefront/verify-domain").default;
if (ORIGINAL_DEPLOYMENT_HOST === undefined)
  delete process.env.REPLIT_DEPLOYMENT_HOST;
else process.env.REPLIT_DEPLOYMENT_HOST = ORIGINAL_DEPLOYMENT_HOST;

const PUBKEY = "ab".repeat(32);
const TOKEN = "tok123";
const DEPLOYMENT_IPS = ["34.1.2.3"];

function mockRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn((body: any) => {
    res.body = body;
    return res;
  });
  res.setHeader = jest.fn(() => res);
  return res as NextApiResponse & { body?: any };
}

function mockReq(): NextApiRequest {
  return { method: "POST", body: { pubkey: PUBKEY } } as any;
}

describe("verify-domain www health reporting", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDomainByPubkeyMock.mockResolvedValue({
      domain: "farm.example",
      verification_token: TOKEN,
      tls_status: "pending_dns",
    });
    // Apex resolves via CNAME, TXT matches — apex verification succeeds.
    resolveCnameMock.mockImplementation((host: string, cb: any) => {
      if (host === "farm.example") cb(null, ["self-sown.com"]);
      else cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    });
    resolveTxtMock.mockImplementation((host: string, cb: any) => {
      if (host === "_self-sown.farm.example") cb(null, [[TOKEN]]);
      else cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    });
    resolve4Mock.mockImplementation((host: string, cb: any) => {
      if (host === "self-sown.com") cb(null, DEPLOYMENT_IPS);
      else cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    });
  });

  afterEach(() => {
    delete process.env.REPLIT_DEPLOYMENT_HOST;
  });

  it("reports www resolves=true when www CNAMEs at the platform", async () => {
    resolveCnameMock.mockImplementation((host: string, cb: any) => {
      if (host === "farm.example" || host === "www.farm.example")
        cb(null, ["self-sown.com"]);
      else cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.body.verified).toBe(true);
    expect(res.body.www).toEqual({
      applicable: true,
      resolves: true,
      observed: { cname: ["self-sown.com"], a: null },
    });
    expect(res.body.message).not.toContain("no www record");
  });

  it("reports www resolves=false when www has no record, without blocking apex verification", async () => {
    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.body.verified).toBe(true);
    expect(markVerifiedMock).toHaveBeenCalledWith(PUBKEY);
    expect(res.body.www).toEqual({
      applicable: true,
      resolves: false,
      observed: { cname: null, a: null },
    });
    // The seller must be told — this is the loud-failure contract.
    expect(res.body.message).toContain("no www record");
  });

  it("accepts www A records matching the deployment IPs", async () => {
    resolve4Mock.mockImplementation((host: string, cb: any) => {
      if (host === "self-sown.com" || host === "www.farm.example")
        cb(null, DEPLOYMENT_IPS);
      else cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.body.www?.resolves).toBe(true);
    expect(res.body.www?.observed.a).toEqual(DEPLOYMENT_IPS);
  });

  it("rejects www pointing at an unrelated host (e.g. registrar parking)", async () => {
    resolveCnameMock.mockImplementation((host: string, cb: any) => {
      if (host === "farm.example") cb(null, ["self-sown.com"]);
      if (host === "www.farm.example") cb(null, ["parking.registrar.example"]);
      else cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    });
    // www A lookup (fallback after CNAME mismatch) resolves the parking host
    // to a foreign IP.
    resolve4Mock.mockImplementation((host: string, cb: any) => {
      if (host === "self-sown.com") cb(null, DEPLOYMENT_IPS);
      if (host === "www.farm.example") cb(null, ["203.0.113.9"]);
      else cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.body.verified).toBe(true);
    expect(res.body.www?.resolves).toBe(false);
    expect(res.body.www?.observed.cname).toEqual(["parking.registrar.example"]);
  });

  it("skips the www check for subdomain custom domains", async () => {
    getDomainByPubkeyMock.mockResolvedValue({
      domain: "shop.farm.example",
      verification_token: TOKEN,
      tls_status: "pending_dns",
    });
    resolveCnameMock.mockImplementation((host: string, cb: any) => {
      if (host === "shop.farm.example") cb(null, ["self-sown.com"]);
      else cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    });
    resolveTxtMock.mockImplementation((host: string, cb: any) => {
      if (host === "_self-sown.shop.farm.example") cb(null, [[TOKEN]]);
      else cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.body.verified).toBe(true);
    expect(res.body.www).toBeNull();
    // www.shop.farm.example must never be queried.
    const queriedHosts = [
      ...resolveCnameMock.mock.calls,
      ...resolve4Mock.mock.calls,
    ].map(([h]) => h);
    expect(queriedHosts).not.toContain("www.shop.farm.example");
  });
});
