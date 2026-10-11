/** @jest-environment node */

// iOS AASA + Android assetlinks association files for the seller app's
// universal links (/auth/recover recovery-email deep links). Both routes
// serve ONLY on the platform host — seller custom domains and self-host
// instances 404 because the app never claims association with those domains.

import aasaHandler from "@/pages/api/.well-known/apple-app-site-association";
import assetlinksHandler from "@/pages/api/.well-known/assetlinks.json";
import { __resetSelfHostConfigCacheForTests } from "@/utils/self-host/config";

const PLATFORM_HOST = "self-sown.com";

function makeReq(host?: string) {
  return { headers: host ? { host } : {} } as any;
}

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    end: jest.fn(),
    setHeader: jest.fn(),
  } as any;
}

beforeEach(() => {
  delete process.env.SS_SELF_HOST;
  delete process.env.MM_SELF_HOST;
  __resetSelfHostConfigCacheForTests();
  process.env.NEXT_PUBLIC_BASE_URL = `https://${PLATFORM_HOST}`;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_BASE_URL;
  delete process.env.SS_SELF_HOST;
  delete process.env.MM_SELF_HOST;
  __resetSelfHostConfigCacheForTests();
});

describe("self-host instances", () => {
  // A self-host export sets NEXT_PUBLIC_BASE_URL to the operator's OWN
  // domain, so the host check alone would pass — the app still must not be
  // associated with that domain. Both routes 404 explicitly.
  it("404 both files even when the request Host matches the instance's base URL", () => {
    process.env.SS_SELF_HOST = "1";
    process.env.NEXT_PUBLIC_BASE_URL = "https://selfhosted.example.com";
    __resetSelfHostConfigCacheForTests();

    for (const handler of [aasaHandler, assetlinksHandler]) {
      const res = makeRes();
      handler(makeReq("selfhosted.example.com"), res);
      expect(res.status).toHaveBeenCalledWith(404);
    }
  });
});

describe("apple-app-site-association", () => {
  it("serves the applinks declaration scoped to /auth/recover on the platform host", () => {
    const res = makeRes();
    aasaHandler(makeReq(PLATFORM_HOST), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/json"
    );
    const body = res.json.mock.calls[0]![0];
    const detail = body.applinks.details[0];
    expect(detail.appIDs).toEqual([
      "JD83N884V6.com.selfsown.mobile",
      "JD83N884V6.com.selfsown.mobile.staging",
    ]);
    // Scoped to the recovery path only — other site links must keep opening
    // in the browser.
    expect(detail.components).toEqual([
      { "/": "/auth/recover", comment: expect.any(String) },
    ]);
  });

  it("matches the platform host with a port, uppercase, or trailing dot", () => {
    for (const host of [`${PLATFORM_HOST}:443`, "SELF-SOWN.COM", `${PLATFORM_HOST}.`]) {
      const res = makeRes();
      aasaHandler(makeReq(host), res);
      expect(res.status).toHaveBeenCalledWith(200);
    }
  });

  it("404s on seller custom domains and self-host instances", () => {
    for (const host of ["shop.farmer.example", "selfhosted.example.com", undefined]) {
      const res = makeRes();
      aasaHandler(makeReq(host), res);
      expect(res.status).toHaveBeenCalledWith(404);
    }
  });
});

describe("assetlinks.json", () => {
  it("serves handle_all_urls statements for both package names on the platform host", () => {
    const res = makeRes();
    assetlinksHandler(makeReq(PLATFORM_HOST), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/json"
    );
    const body = res.json.mock.calls[0]![0];
    expect(body).toHaveLength(2);
    for (const statement of body) {
      expect(statement.relation).toEqual([
        "delegate_permission/common.handle_all_urls",
      ]);
      expect(statement.target.namespace).toBe("android_app");
      expect(
        statement.target.sha256_cert_fingerprints[0]
      ).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    }
    expect(body.map((s: any) => s.target.package_name)).toEqual([
      "com.selfsown.mobile",
      "com.selfsown.mobile.staging",
    ]);
  });

  it("404s off the platform host", () => {
    const res = makeRes();
    assetlinksHandler(makeReq("shop.farmer.example"), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
