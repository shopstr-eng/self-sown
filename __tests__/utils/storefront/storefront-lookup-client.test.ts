/** @jest-environment node */

import { lookupStorefront } from "@/utils/storefront/storefront-lookup-client";

describe("lookupStorefront", () => {
  const origFetch = global.fetch;

  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  it("resolves on a 200 with a pubkey", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ pubkey: "pk", shopSlug: "farm" }),
    }) as unknown as typeof fetch;

    const r = await lookupStorefront({ slug: "farm" }, { baseDelayMs: 0 });
    expect(r).toEqual({ status: "resolved", pubkey: "pk", shopSlug: "farm" });
  });

  it("treats HTTP 404 as definitive not_found and does not retry", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const r = await lookupStorefront({ slug: "missing" }, { baseDelayMs: 0 });
    expect(r).toEqual({ status: "not_found" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 5xx and then succeeds", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ pubkey: "pk2" }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const r = await lookupStorefront({ slug: "flaky" }, { baseDelayMs: 0 });
    expect(r).toEqual({ status: "resolved", pubkey: "pk2", shopSlug: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns transient_error after exhausting retries", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const r = await lookupStorefront(
      { slug: "down" },
      { maxAttempts: 3, baseDelayMs: 0 }
    );
    expect(r).toEqual({ status: "transient_error" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a thrown network error and then succeeds", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ pubkey: "pk3" }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const r = await lookupStorefront(
      { domain: "shop.example" },
      { baseDelayMs: 0 }
    );
    expect(r).toEqual({ status: "resolved", pubkey: "pk3", shopSlug: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns not_found when no slug/domain is given", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const r = await lookupStorefront({ slug: "" }, { baseDelayMs: 0 });
    expect(r).toEqual({ status: "not_found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
