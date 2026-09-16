/**
 * Square Apple Pay domain activation. Square's platform flow is two-part: the
 * well-known association file (served elsewhere) plus POST /v2/apple-pay/domains
 * authenticated as the platform. Activation is fail-open (a failure must never
 * block checkout), deduped in-process, and host trust is never
 * request-controlled — only the canonical platform host, a verified custom
 * domain owned by the seller, or a self-host instance's own domain is
 * registered.
 */
const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

const getDomainByHostMock = jest.fn();
jest.mock("@/utils/db/custom-domains", () => ({
  getDomainByHost: (...args: unknown[]) => getDomainByHostMock(...args),
}));

const hasSquareConnectionMock = jest.fn();
jest.mock("@/utils/db/square-service", () => ({
  hasSquareConnection: (...args: unknown[]) =>
    hasSquareConnectionMock(...args),
}));

const isSelfHostMock = jest.fn();
jest.mock("@/utils/self-host/config", () => ({
  isSelfHost: () => isSelfHostMock(),
}));

import {
  activateSquareApplePayDomain,
  __resetActivatedSquareApplePayDomains,
} from "@/utils/square/apple-pay";

const SELLER = "ab".repeat(32);

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

describe("activateSquareApplePayDomain", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    getDomainByHostMock.mockReset();
    hasSquareConnectionMock.mockReset().mockResolvedValue(true);
    isSelfHostMock.mockReset().mockReturnValue(false);
    __resetActivatedSquareApplePayDomains();
    process.env.SQUARE_ACCESS_TOKEN = "sq_platform_token";
    process.env.SQUARE_ENVIRONMENT = "production";
    process.env.NEXT_PUBLIC_BASE_URL = "https://platform.example.com";
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "VERIFIED" }));
    // Verified custom domain owned by the seller, by default.
    getDomainByHostMock.mockResolvedValue({ verified: true, pubkey: SELLER });
  });

  afterEach(() => {
    delete process.env.SQUARE_ACCESS_TOKEN;
  });

  it("activates a verified seller domain as the platform and caches it", async () => {
    await expect(
      activateSquareApplePayDomain("SHOP.example.com:443", SELLER)
    ).resolves.toBe("shop.example.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://connect.squareup.com/v2/apple-pay/domains");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sq_platform_token"
    );
    expect(JSON.parse(init.body as string)).toEqual({
      domain_name: "shop.example.com",
    });
    // Second activation of the same domain is a cache hit — no API call.
    await activateSquareApplePayDomain("shop.example.com", SELLER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("activates the platform host for a Square-connected seller's checkout", async () => {
    await expect(
      activateSquareApplePayDomain("platform.example.com", SELLER)
    ).resolves.toBe("platform.example.com");
    // The canonical host is trusted without a custom-domain lookup.
    expect(getDomainByHostMock).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      domain_name: "platform.example.com",
    });
  });

  it("does not activate the platform host without a seller context", async () => {
    await expect(
      activateSquareApplePayDomain("platform.example.com")
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not activate the platform host for a seller with no Square connection", async () => {
    hasSquareConnectionMock.mockResolvedValue(false);
    await expect(
      activateSquareApplePayDomain("platform.example.com", SELLER)
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not cache a PENDING registration — it retries on the next checkout", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "PENDING" }));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      activateSquareApplePayDomain("pending.example.com", SELLER)
    ).resolves.toBeNull();
    fetchMock.mockResolvedValue(jsonResponse(200, { status: "VERIFIED" }));
    await expect(
      activateSquareApplePayDomain("pending.example.com", SELLER)
    ).resolves.toBe("pending.example.com");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("coalesces concurrent activations of the same domain (single-flight)", async () => {
    let release!: (r: unknown) => void;
    fetchMock.mockImplementation(
      () => new Promise((resolve) => (release = resolve))
    );
    const p1 = activateSquareApplePayDomain("race.example.com", SELLER);
    const p2 = activateSquareApplePayDomain("race.example.com", SELLER);
    // Let both callers pass the async trust gates and reach the shared fetch.
    for (let i = 0; i < 100 && fetchMock.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    release(jsonResponse(200, { status: "VERIFIED" }));
    await expect(p1).resolves.toBe("race.example.com");
    await expect(p2).resolves.toBe("race.example.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("swallows an aborted/timed-out request and stays retryable", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortErr);
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      activateSquareApplePayDomain("slow.example.com", SELLER)
    ).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "VERIFIED" }));
    await expect(
      activateSquareApplePayDomain("slow.example.com", SELLER)
    ).resolves.toBe("slow.example.com");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("does not cache a duplicate 'already registered' response — only VERIFIED counts", async () => {
    // A duplicate response proves the domain is REGISTERED, not that Apple has
    // VERIFIED it; caching it would suppress retries and could leave the Apple
    // Pay button hidden for the process lifetime.
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        errors: [{ code: "BAD_REQUEST", detail: "Domain already registered" }],
      })
    );
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      activateSquareApplePayDomain("dupe.example.com", SELLER)
    ).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "VERIFIED" }));
    await expect(
      activateSquareApplePayDomain("dupe.example.com", SELLER)
    ).resolves.toBe("dupe.example.com");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Only after VERIFIED is the domain deduped.
    await activateSquareApplePayDomain("dupe.example.com", SELLER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("swallows activation failures (never blocks checkout) and retries later", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { errors: [{}] }));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      activateSquareApplePayDomain("flaky.example.com", SELLER)
    ).resolves.toBeNull();
    await activateSquareApplePayDomain("flaky.example.com", SELLER);
    // Not cached: both attempts hit the API.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(
      activateSquareApplePayDomain("flaky.example.com", SELLER)
    ).resolves.toBeNull();
    spy.mockRestore();
  });

  it("no-ops without a platform token", async () => {
    delete process.env.SQUARE_ACCESS_TOKEN;
    await expect(
      activateSquareApplePayDomain("shop.example.com", SELLER)
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips sellers without a Square connection (Stripe sellers need no Square registration)", async () => {
    hasSquareConnectionMock.mockResolvedValue(false);
    await expect(
      activateSquareApplePayDomain("stripe-seller.example.com", SELLER)
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects untrusted hosts: unverified, foreign-owned, unknown, and non-domains", async () => {
    getDomainByHostMock.mockResolvedValueOnce({
      verified: false,
      pubkey: SELLER,
    });
    await expect(
      activateSquareApplePayDomain("unverified.example.com", SELLER)
    ).resolves.toBeNull();
    getDomainByHostMock.mockResolvedValueOnce({
      verified: true,
      pubkey: "cd".repeat(32),
    });
    await expect(
      activateSquareApplePayDomain("someone-else.example.com", SELLER)
    ).resolves.toBeNull();
    getDomainByHostMock.mockResolvedValueOnce(null);
    await expect(
      activateSquareApplePayDomain("attacker.example.com", SELLER)
    ).resolves.toBeNull();
    await expect(
      activateSquareApplePayDomain("localhost:3000", SELLER)
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails open when the connection check errors (retried on next checkout)", async () => {
    hasSquareConnectionMock.mockRejectedValue(new Error("db down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      activateSquareApplePayDomain("blip.example.com", SELLER)
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("trusts the self-host instance's own domain without a seller check", async () => {
    isSelfHostMock.mockReturnValue(true);
    process.env.NEXT_PUBLIC_BASE_URL = "https://myshop.example.com";
    await expect(
      activateSquareApplePayDomain("myshop.example.com", SELLER)
    ).resolves.toBe("myshop.example.com");
    expect(hasSquareConnectionMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A different host on a self-host instance is still rejected.
    getDomainByHostMock.mockResolvedValue(null);
    await expect(
      activateSquareApplePayDomain("not-mine.example.com", SELLER)
    ).resolves.toBeNull();
  });
});
