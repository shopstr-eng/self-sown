/** @jest-environment node */

import { lookupByHost } from "@/utils/storefront/host-cache";

describe("lookupByHost negative caching", () => {
  const origFetch = global.fetch;

  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  it("resolves a 200 and caches the positive result", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ shopSlug: "farm", pubkey: "pk1" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const a = await lookupByHost("", "resolve.example");
    const b = await lookupByHost("", "resolve.example");

    expect(a).toEqual({ slug: "farm", pubkey: "pk1" });
    expect(b).toEqual({ slug: "farm", pubkey: "pk1" });
    // Second call served from cache.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches a DEFINITIVE 404 negative", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const a = await lookupByHost("", "missing.example");
    const b = await lookupByHost("", "missing.example");

    expect(a).toEqual({ slug: null, pubkey: null });
    expect(b).toEqual({ slug: null, pubkey: null });
    // 404 is cached, so only one network call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a transient 5xx — the next request retries", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const a = await lookupByHost("", "blip500.example");
    const b = await lookupByHost("", "blip500.example");

    expect(a).toEqual({ slug: null, pubkey: null });
    expect(b).toEqual({ slug: null, pubkey: null });
    // Not cached, so both requests hit the network.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache a network/TLS error — the next request retries", async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error("network"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const a = await lookupByHost("", "neterr.example");
    const b = await lookupByHost("", "neterr.example");

    expect(a).toEqual({ slug: null, pubkey: null });
    expect(b).toEqual({ slug: null, pubkey: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
