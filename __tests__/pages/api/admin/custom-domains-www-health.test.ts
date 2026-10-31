/** @jest-environment node */

// The admin domains list reports per-domain www health so a missing www
// attachment is visible before a seller goes live. The critical contract:
// DNS is checked BEFORE any TLS verdict. Apex verification says nothing
// about www — a registrar parking page serves valid HTTPS, so probing TLS
// without the DNS check would paint a parked www host green ("www TLS ✓")
// while buyers never reach the storefront.

import type { NextApiRequest, NextApiResponse } from "next";

const listDomainsMock = jest.fn();
jest.mock("@/utils/db/custom-domains", () => ({
  listDomains: (filter?: unknown) => listDomainsMock(filter),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

// Auth bypassed via the server-to-server secret path (set in beforeEach).

const checkWwwHealthMock = jest.fn();
jest.mock("@/utils/custom-domain-www-health", () => ({
  checkWwwVariantHealth: (domain: string) => checkWwwHealthMock(domain),
}));

// Lifecycle advancement (DNS + TLS probing) is unit-tested on its own; here
// it's an inert pass-through so the list-endpoint tests stay hermetic.
jest.mock("@/utils/custom-domain-lifecycle", () => ({
  advanceCustomDomainStatus: jest.fn(async (row: any) => ({
    changed: false,
    verified: row.verified,
    from: row.tls_status,
    to: row.tls_status,
  })),
  WWW_CNAME_TARGET: "self-sown.com",
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const handler = require("@/pages/api/admin/custom-domains").default;

const PUBKEY = "cd".repeat(32);

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
  return {
    method: "GET",
    query: {},
    headers: { "x-admin-secret": "test-secret" },
  } as any;
}

function apexRow(overrides: Record<string, unknown> = {}) {
  return {
    domain: "farm.example",
    pubkey: PUBKEY,
    shop_slug: "farm",
    verified: true,
    domain_type: "apex",
    verification_token: null,
    tls_status: "attached",
    attached_at: null,
    admin_notified_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("admin custom-domains www health", () => {
  const ORIGINAL_SECRET = process.env.ADMIN_API_SECRET;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_API_SECRET = "test-secret";
  });
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.ADMIN_API_SECRET;
    else process.env.ADMIN_API_SECRET = ORIGINAL_SECRET;
  });

  it("never reports a parked www host as attached: dns_mismatch beats a valid-HTTPS parking page", async () => {
    listDomainsMock.mockResolvedValue([apexRow()]);
    // The shared helper returns dns_mismatch WITHOUT probing TLS when www
    // points at a parking page — that's the whole point of checking DNS
    // first. This test pins the admin route to surfacing that state verbatim
    // instead of flattening it into "not attached".
    checkWwwHealthMock.mockResolvedValue({
      applicable: true,
      state: "dns_mismatch",
      resolves: false,
      tlsOk: null,
      tlsReason: null,
      observed: { cname: ["parking.registrar.example"], a: null },
    });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(checkWwwHealthMock).toHaveBeenCalledWith("farm.example");
    expect(res.body.domains[0].wwwTls).toEqual({
      ok: false,
      state: "dns_mismatch",
    });
  });

  it("reports a certificate failure as certificate, distinct from missing DNS", async () => {
    listDomainsMock.mockResolvedValue([apexRow()]);
    checkWwwHealthMock.mockResolvedValue({
      applicable: true,
      state: "certificate",
      resolves: true,
      tlsOk: false,
      tlsReason: "certificate",
      observed: { cname: ["self-sown.com"], a: null },
    });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.body.domains[0].wwwTls).toEqual({
      ok: false,
      state: "certificate",
    });
  });

  it("reports ok only when DNS points at us AND TLS terminates", async () => {
    listDomainsMock.mockResolvedValue([apexRow({ tls_status: "active" })]);
    checkWwwHealthMock.mockResolvedValue({
      applicable: true,
      state: "ok",
      resolves: true,
      tlsOk: true,
      tlsReason: null,
      observed: { cname: ["self-sown.com"], a: null },
    });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.body.domains[0].wwwTls).toEqual({ ok: true, state: "ok" });
  });

  it("surfaces unreachable as its own state, not a missing certificate", async () => {
    listDomainsMock.mockResolvedValue([apexRow()]);
    checkWwwHealthMock.mockResolvedValue({
      applicable: true,
      state: "unreachable",
      resolves: true,
      tlsOk: false,
      tlsReason: "unreachable",
      observed: { cname: ["self-sown.com"], a: null },
    });

    const res = mockRes();
    await handler(mockReq(), res);

    expect(res.body.domains[0].wwwTls).toEqual({
      ok: false,
      state: "unreachable",
    });
  });

  it("skips the www check for subdomain, unverified, and pre-DNS rows", async () => {
    listDomainsMock.mockResolvedValue([
      apexRow({ domain: "shop.farm.example", domain_type: "subdomain" }),
      apexRow({ domain: "unverified.example", verified: false }),
      apexRow({ domain: "pending.example", tls_status: "pending_dns" }),
      apexRow({ domain: "failed.example", tls_status: "failed" }),
    ]);

    const res = mockRes();
    await handler(mockReq(), res);

    expect(checkWwwHealthMock).not.toHaveBeenCalled();
    for (const d of res.body.domains) {
      expect(d.wwwTls).toBeNull();
    }
  });
});
