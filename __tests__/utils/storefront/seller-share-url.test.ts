/**
 * Regression coverage for the client share-URL helper. The key contract:
 * navigator.share must be invoked synchronously from the click (transient
 * user activation), so the domain lookup is prefetched and read from a
 * synchronous cache — a cold or delayed lookup must NOT delay sharing, and a
 * genuine share failure must recover visibly via clipboard copy.
 */
import {
  getCachedSellerCustomDomainBaseUrl,
  prefetchSellerCustomDomainBaseUrl,
  shareProductUrl,
  __resetSellerShareUrlCacheForTests,
} from "@/utils/storefront/seller-share-url";
import { copyToClipboard } from "@/utils/clipboard";

jest.mock("@/utils/clipboard", () => ({ copyToClipboard: jest.fn() }));

const PUBKEY = "b".repeat(64);
const copyMock = copyToClipboard as jest.Mock;
let fetchMock: jest.Mock;

const flushMicrotasks = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

beforeEach(() => {
  __resetSellerShareUrlCacheForTests();
  jest.clearAllMocks();
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  copyMock.mockResolvedValue(undefined);
  delete (navigator as { share?: unknown }).share;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("custom-domain cache", () => {
  it("returns null synchronously while the first lookup is still in flight, then serves the domain", async () => {
    // Cold, delayed lookup: the share handler must not wait on this.
    let resolveFetch!: (v: unknown) => void;
    fetchMock.mockReturnValue(
      new Promise((r) => {
        resolveFetch = r;
      })
    );

    expect(getCachedSellerCustomDomainBaseUrl(PUBKEY)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch({
      ok: true,
      json: async () => ({ verified: true, domain: "shop.example.com" }),
    });
    await flushMicrotasks();

    expect(getCachedSellerCustomDomainBaseUrl(PUBKEY)).toBe(
      "https://shop.example.com"
    );
  });

  it("caches a verified domain without refetching", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ verified: true, domain: "shop.example.com" }),
    });
    prefetchSellerCustomDomainBaseUrl(PUBKEY);
    await flushMicrotasks();

    expect(getCachedSellerCustomDomainBaseUrl(PUBKEY)).toBe(
      "https://shop.example.com"
    );
    expect(getCachedSellerCustomDomainBaseUrl(PUBKEY)).toBe(
      "https://shop.example.com"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores unverified domains", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ verified: false, domain: "shop.example.com" }),
    });
    prefetchSellerCustomDomainBaseUrl(PUBKEY);
    await flushMicrotasks();

    expect(getCachedSellerCustomDomainBaseUrl(PUBKEY)).toBeNull();
  });

  it("does not cache a failed lookup forever — retries after the negative TTL", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    prefetchSellerCustomDomainBaseUrl(PUBKEY);
    await flushMicrotasks();

    expect(getCachedSellerCustomDomainBaseUrl(PUBKEY)).toBeNull();
    expect(getCachedSellerCustomDomainBaseUrl(PUBKEY)).toBeNull();
    // Within the TTL the failure is served from cache.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past the TTL the next read kicks off a background retry...
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ verified: true, domain: "shop.example.com" }),
    });
    expect(getCachedSellerCustomDomainBaseUrl(PUBKEY)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();

    // ...and once the retry settles the domain is served.
    await flushMicrotasks();
    expect(getCachedSellerCustomDomainBaseUrl(PUBKEY)).toBe(
      "https://shop.example.com"
    );
  });

  it("survives a hung endpoint via the fetch timeout path", async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      );
      prefetchSellerCustomDomainBaseUrl(PUBKEY);
      jest.advanceTimersByTime(3_000);
      await flushMicrotasks();
      expect(getCachedSellerCustomDomainBaseUrl(PUBKEY)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("shareProductUrl", () => {
  const setNavigatorShare = (impl: unknown) =>
    Object.defineProperty(window.navigator, "share", {
      value: impl,
      configurable: true,
    });

  it("invokes navigator.share synchronously with the resolved URL", () => {
    const shareMock = jest.fn().mockResolvedValue(undefined);
    setNavigatorShare(shareMock);
    const onCopied = jest.fn();

    shareProductUrl({
      title: "Fresh eggs",
      shareUrl: "https://shop.example.com/listing/abc",
      onCopied,
    });

    expect(shareMock).toHaveBeenCalledTimes(1);
    expect(shareMock).toHaveBeenCalledWith({
      title: "Fresh eggs",
      url: "https://shop.example.com/listing/abc",
    });
  });

  it("falls back to clipboard + onCopied when the share sheet fails (e.g. lost activation)", async () => {
    const shareMock = jest
      .fn()
      .mockRejectedValue(new DOMException("no activation", "NotAllowedError"));
    setNavigatorShare(shareMock);
    const onCopied = jest.fn();

    shareProductUrl({
      title: "Fresh eggs",
      shareUrl: "https://shop.example.com/listing/abc",
      onCopied,
    });
    await flushMicrotasks();

    expect(copyMock).toHaveBeenCalledWith(
      "https://shop.example.com/listing/abc"
    );
    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the user dismisses the share sheet (AbortError)", async () => {
    const shareMock = jest
      .fn()
      .mockRejectedValue(new DOMException("cancelled", "AbortError"));
    setNavigatorShare(shareMock);
    const onCopied = jest.fn();

    shareProductUrl({
      title: "Fresh eggs",
      shareUrl: "https://shop.example.com/listing/abc",
      onCopied,
    });
    await flushMicrotasks();

    expect(copyMock).not.toHaveBeenCalled();
    expect(onCopied).not.toHaveBeenCalled();
  });

  it("copies to clipboard when navigator.share is unavailable", async () => {
    const onCopied = jest.fn();

    shareProductUrl({
      title: "Fresh eggs",
      shareUrl: "https://shop.example.com/listing/abc",
      onCopied,
    });
    await flushMicrotasks();

    expect(copyMock).toHaveBeenCalledWith(
      "https://shop.example.com/listing/abc"
    );
    expect(onCopied).toHaveBeenCalledTimes(1);
  });
});
