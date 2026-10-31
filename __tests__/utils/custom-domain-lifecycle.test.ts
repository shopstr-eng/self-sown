/** @jest-environment node */

// Automatic custom-domain lifecycle advancement: the admin domains list and
// the seller's own domain GET call advanceCustomDomainStatus so statuses
// converge without anyone clicking "verify" or flipping the admin dropdown.
// Contract under test: transitions are FORWARD-ONLY (a failed probe never
// demotes a live row), terminal states (active/failed) are never probed,
// TLS is only probed AFTER DNS verifies (a parked registrar page serving
// valid HTTPS must not read as "active"), and storage/network failures
// leave the stored row untouched.

const resolveCnameMock = jest.fn();
const resolve4Mock = jest.fn();
const resolveTxtMock = jest.fn();

// The module promisifies dns.* at module scope, so the mocks must be
// callback-style functions delegating to swappable jest.fns.
jest.mock("dns", () => ({
  resolveCname: (host: string, cb: (e: any, r?: string[]) => void) =>
    resolveCnameMock(host, cb),
  resolve4: (host: string, cb: (e: any, r?: string[]) => void) =>
    resolve4Mock(host, cb),
  resolveTxt: (host: string, cb: (e: any, r?: string[][]) => void) =>
    resolveTxtMock(host, cb),
}));

const markVerifiedMock = jest.fn(async (_pubkey: string) => {});
const setTlsStatusMock = jest.fn(
  async (_domain: string, _status: string) => {}
);
jest.mock("@/utils/db/custom-domains", () => ({
  markVerified: (pubkey: string) => markVerifiedMock(pubkey),
  setTlsStatus: (domain: string, status: string) =>
    setTlsStatusMock(domain, status),
}));

jest.mock("@/utils/site-url", () => ({
  SITE_HOST: "self-sown.com",
}));

const probeWwwTlsMock = jest.fn();
jest.mock("@/utils/www-tls-probe", () => ({
  probeWwwTls: (...args: unknown[]) => probeWwwTlsMock(...args),
}));

// PRIMARY_HOST is captured at module load, so pin the env BEFORE require
// (this environment exports a real REPLIT_DEPLOYMENT_HOST).
const ORIGINAL_DEPLOYMENT_HOST = process.env.REPLIT_DEPLOYMENT_HOST;
process.env.REPLIT_DEPLOYMENT_HOST = "self-sown.com";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lifecycle = require("@/utils/custom-domain-lifecycle");
if (ORIGINAL_DEPLOYMENT_HOST === undefined)
  delete process.env.REPLIT_DEPLOYMENT_HOST;
else process.env.REPLIT_DEPLOYMENT_HOST = ORIGINAL_DEPLOYMENT_HOST;

const { advanceCustomDomainStatus, WWW_CNAME_TARGET } = lifecycle;

const PUBKEY = "ab".repeat(32);
const TOKEN = "tok123";
const DEPLOYMENT_IPS = ["34.1.2.3"];

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    pubkey: PUBKEY,
    domain: "farm.example",
    shop_slug: "farm",
    verified: false,
    domain_type: "apex",
    verification_token: TOKEN,
    tls_status: "pending_dns",
    attached_at: null,
    admin_notified_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as any;
}

// DNS state for a fully-configured domain: CNAME at the deployment + the
// ownership TXT record.
function dnsAllMatching() {
  resolveCnameMock.mockImplementation((host: string, cb: any) =>
    host === "farm.example"
      ? cb(null, ["self-sown.com"])
      : cb(new Error("ENODATA"))
  );
  resolveTxtMock.mockImplementation((host: string, cb: any) =>
    host === "_self-sown.farm.example"
      ? cb(null, [[TOKEN]])
      : cb(new Error("ENOTFOUND"))
  );
}

describe("advanceCustomDomainStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveCnameMock.mockImplementation((_h: string, cb: any) =>
      cb(new Error("ENODATA"))
    );
    resolve4Mock.mockImplementation((_h: string, cb: any) =>
      cb(new Error("ENOTFOUND"))
    );
    resolveTxtMock.mockImplementation((_h: string, cb: any) =>
      cb(new Error("ENOTFOUND"))
    );
    probeWwwTlsMock.mockResolvedValue({
      ok: false,
      reason: "unreachable",
      errorCode: null,
    });
  });

  it("exposes the www CNAME target for dashboard display", () => {
    expect(WWW_CNAME_TARGET).toBe("self-sown.com");
  });

  it("auto-verifies a pending row once DNS matches (cert not live yet)", async () => {
    dnsAllMatching();
    probeWwwTlsMock.mockResolvedValue({
      ok: false,
      reason: "certificate",
      errorCode: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    const res = await advanceCustomDomainStatus(makeRow());
    expect(markVerifiedMock).toHaveBeenCalledWith(PUBKEY);
    expect(setTlsStatusMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      changed: true,
      verified: true,
      from: "pending_dns",
      to: "dns_verified",
    });
  });

  it("auto-verifies and activates in one pass when the cert is already live", async () => {
    dnsAllMatching();
    probeWwwTlsMock.mockResolvedValue({
      ok: true,
      reason: null,
      errorCode: null,
    });
    const res = await advanceCustomDomainStatus(makeRow());
    expect(markVerifiedMock).toHaveBeenCalledWith(PUBKEY);
    expect(setTlsStatusMock).toHaveBeenCalledWith("farm.example", "active");
    expect(res.to).toBe("active");
  });

  it("verifies via A records when there is no CNAME", async () => {
    resolve4Mock.mockImplementation((host: string, cb: any) => {
      if (host === "self-sown.com") return cb(null, DEPLOYMENT_IPS);
      if (host === "farm.example") return cb(null, DEPLOYMENT_IPS);
      return cb(new Error("ENOTFOUND"));
    });
    resolveTxtMock.mockImplementation((host: string, cb: any) =>
      host === "_self-sown.farm.example"
        ? cb(null, [[TOKEN]])
        : cb(new Error("ENOTFOUND"))
    );
    const res = await advanceCustomDomainStatus(makeRow());
    expect(markVerifiedMock).toHaveBeenCalledWith(PUBKEY);
    expect(res.verified).toBe(true);
  });

  it("requires no TXT record when no token was issued", async () => {
    dnsAllMatching(); // CNAME matches; TXT lookups fail but no token exists
    const res = await advanceCustomDomainStatus(
      makeRow({ verification_token: null })
    );
    expect(markVerifiedMock).toHaveBeenCalledWith(PUBKEY);
    expect(res.verified).toBe(true);
  });

  it("leaves a pending row untouched when DNS does not match", async () => {
    const res = await advanceCustomDomainStatus(makeRow());
    expect(markVerifiedMock).not.toHaveBeenCalled();
    expect(probeWwwTlsMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ changed: false, to: "pending_dns" });
  });

  it("never probes TLS before DNS verifies, even if the cert is live", async () => {
    // A parked registrar page can serve valid HTTPS — probing before DNS
    // verification would read "active" while buyers never reach us.
    probeWwwTlsMock.mockResolvedValue({
      ok: true,
      reason: null,
      errorCode: null,
    });
    const res = await advanceCustomDomainStatus(makeRow());
    expect(probeWwwTlsMock).not.toHaveBeenCalled();
    expect(setTlsStatusMock).not.toHaveBeenCalled();
    expect(res.changed).toBe(false);
  });

  it("flips dns_verified → active once the certificate terminates TLS", async () => {
    probeWwwTlsMock.mockResolvedValue({
      ok: true,
      reason: null,
      errorCode: null,
    });
    const res = await advanceCustomDomainStatus(
      makeRow({ verified: true, tls_status: "dns_verified" })
    );
    expect(markVerifiedMock).not.toHaveBeenCalled();
    expect(resolveCnameMock).not.toHaveBeenCalled();
    expect(setTlsStatusMock).toHaveBeenCalledWith("farm.example", "active");
    expect(res).toMatchObject({
      changed: true,
      from: "dns_verified",
      to: "active",
    });
  });

  it("flips attached → active once the certificate terminates TLS", async () => {
    probeWwwTlsMock.mockResolvedValue({
      ok: true,
      reason: null,
      errorCode: null,
    });
    const res = await advanceCustomDomainStatus(
      makeRow({ verified: true, tls_status: "attached" })
    );
    expect(setTlsStatusMock).toHaveBeenCalledWith("farm.example", "active");
    expect(res.to).toBe("active");
  });

  it("never demotes: a failed probe leaves dns_verified alone", async () => {
    probeWwwTlsMock.mockResolvedValue({
      ok: false,
      reason: "certificate",
      errorCode: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    const res = await advanceCustomDomainStatus(
      makeRow({ verified: true, tls_status: "dns_verified" })
    );
    expect(setTlsStatusMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ changed: false, to: "dns_verified" });
  });

  it("never touches terminal rows (active/failed) — no DNS, no probe", async () => {
    for (const status of ["active", "failed"]) {
      jest.clearAllMocks();
      const res = await advanceCustomDomainStatus(
        makeRow({ verified: true, tls_status: status })
      );
      expect(resolveCnameMock).not.toHaveBeenCalled();
      expect(probeWwwTlsMock).not.toHaveBeenCalled();
      expect(markVerifiedMock).not.toHaveBeenCalled();
      expect(setTlsStatusMock).not.toHaveBeenCalled();
      expect(res).toMatchObject({ changed: false, to: status });
    }
  });

  it("fails open when storage throws: stored status is left untouched", async () => {
    dnsAllMatching();
    markVerifiedMock.mockRejectedValueOnce(new Error("db down"));
    const res = await advanceCustomDomainStatus(makeRow());
    expect(res).toMatchObject({
      changed: false,
      to: "pending_dns",
      verified: false,
    });
    expect(setTlsStatusMock).not.toHaveBeenCalled();
  });
});
