/** @jest-environment node */

// probeWwwTls classifies safeFetch failures into "certificate" (the host was
// never attached to the deployment — the actionable admin case) vs
// "unreachable" (DNS/connectivity-level), and treats ANY completed HTTP
// response (even a 404 or the platform's www→apex 301) as TLS success.

import { SafeFetchError } from "@/utils/url-safety";

const safeFetchMock = jest.fn();
jest.mock("@/utils/url-safety", () => {
  const actual = jest.requireActual("@/utils/url-safety");
  return {
    ...actual,
    safeFetch: (url: string, opts?: unknown) => safeFetchMock(url, opts),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { probeWwwTls } = require("@/utils/www-tls-probe");

describe("probeWwwTls", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns ok=true when any HTTP response comes back", async () => {
    safeFetchMock.mockResolvedValue({ status: 301 });
    const r = await probeWwwTls("www.farm.example");
    expect(r).toEqual({ ok: true, reason: null, errorCode: null });
    expect(safeFetchMock).toHaveBeenCalledWith("https://www.farm.example/", {
      method: "HEAD",
      timeoutMs: 5000,
    });
  });

  it.each([
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "EPROTO",
  ])(
    "classifies undici cert error %s as a certificate failure",
    async (code) => {
      const err: any = new TypeError("fetch failed");
      err.cause = Object.assign(new Error("certificate error"), { code });
      safeFetchMock.mockRejectedValue(err);

      const r = await probeWwwTls("www.farm.example");
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("certificate");
      expect(r.errorCode).toBe(code);
    }
  );

  it.each(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"])(
    "classifies network error %s as unreachable, not certificate",
    async (code) => {
      const err: any = new TypeError("fetch failed");
      err.cause = Object.assign(new Error("connect failed"), { code });
      safeFetchMock.mockRejectedValue(err);

      const r = await probeWwwTls("www.farm.example");
      expect(r).toEqual({ ok: false, reason: "unreachable", errorCode: code });
    }
  );

  it("classifies SSRF-guard rejection as unreachable (DNS-level)", async () => {
    safeFetchMock.mockRejectedValue(
      new SafeFetchError("URL host is not allowed")
    );
    const r = await probeWwwTls("www.farm.example");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unreachable");
  });

  it("classifies abort/timeout as unreachable", async () => {
    const err: any = new Error("This operation was aborted");
    err.name = "AbortError";
    safeFetchMock.mockRejectedValue(err);
    const r = await probeWwwTls("www.farm.example");
    expect(r).toEqual({ ok: false, reason: "unreachable", errorCode: null });
  });

  it("never throws", async () => {
    safeFetchMock.mockRejectedValue(new Error("totally unexpected"));
    await expect(probeWwwTls("www.farm.example")).resolves.toMatchObject({
      ok: false,
      reason: "unreachable",
    });
  });
});
