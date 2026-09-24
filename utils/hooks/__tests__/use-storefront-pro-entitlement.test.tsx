import { act, renderHook, waitFor } from "@testing-library/react";
import {
  PRO_STATUS_LKG_TTL_MS,
  PRO_STATUS_MAX_ATTEMPTS,
  readLastKnownGoodMembership,
  resetPublicMembershipCache,
} from "@/utils/pro/use-public-membership";
import { useStorefrontProEntitlement } from "../use-storefront-pro-entitlement";
import type { MembershipView } from "@/utils/pro/constants";

const PRO_SELLER = "a".repeat(64);
const OTHER_SELLER = "b".repeat(64);

const proView = (pubkey: string, isPro: boolean): MembershipView => ({
  pubkey,
  status: isPro ? "active" : "free",
  isPro,
  canEdit: isPro,
  isTrialing: false,
  isReadOnly: false,
  isHidden: false,
  isPubliclyVisible: true,
  isLifetime: false,
  billingMethod: null,
  term: null,
  trialEnd: null,
  currentPeriodEnd: null,
  graceUntil: null,
  readonlyUntil: null,
  cancelAtPeriodEnd: false,
});

const okResponse = (pubkey: string, isPro: boolean) =>
  ({ ok: true, json: async () => proView(pubkey, isPro) }) as Response;
const errorResponse = () =>
  ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response;

const isProCached = (pubkey: string) =>
  readLastKnownGoodMembership(pubkey)?.isPro ?? null;

let fetchMock: jest.Mock;

describe("useStorefrontProEntitlement", () => {
  beforeEach(() => {
    localStorage.clear();
    resetPublicMembershipCache();
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  it("returns null while unresolved, then true for a Pro seller", async () => {
    fetchMock.mockResolvedValue(okResponse(PRO_SELLER, true));
    const { result } = renderHook(() =>
      useStorefrontProEntitlement(PRO_SELLER)
    );
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(true));
    expect(isProCached(PRO_SELLER)).toBe(true);
  });

  it("fails closed on a definitive 200 + isPro:false", async () => {
    fetchMock.mockResolvedValue(okResponse(PRO_SELLER, false));
    const { result } = renderHook(() =>
      useStorefrontProEntitlement(PRO_SELLER)
    );
    await waitFor(() => expect(result.current).toBe(false));
    expect(isProCached(PRO_SELLER)).toBe(false);
  });

  it("a definitive isPro:false overrides a stale cached entitlement", async () => {
    // Seller was Pro at last check but has since lapsed.
    fetchMock.mockResolvedValue(okResponse(PRO_SELLER, true));
    const first = renderHook(() => useStorefrontProEntitlement(PRO_SELLER));
    await waitFor(() => expect(first.result.current).toBe(true));
    first.unmount();
    resetPublicMembershipCache();

    fetchMock.mockResolvedValue(okResponse(PRO_SELLER, false));
    const { result } = renderHook(() =>
      useStorefrontProEntitlement(PRO_SELLER)
    );
    await waitFor(() => expect(result.current).toBe(false));
    expect(isProCached(PRO_SELLER)).toBe(false);
  });

  it("retries transient failures before resolving", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(errorResponse())
      .mockResolvedValueOnce(okResponse(PRO_SELLER, true));
    const { result } = renderHook(() =>
      useStorefrontProEntitlement(PRO_SELLER)
    );
    await waitFor(() => expect(result.current).toBe(true), {
      timeout: 10000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 15000);

  it("keeps premium styling (cached true) when the status check terminally fails", async () => {
    // Establish a last-known-good entitlement.
    fetchMock.mockResolvedValue(okResponse(PRO_SELLER, true));
    const first = renderHook(() => useStorefrontProEntitlement(PRO_SELLER));
    await waitFor(() => expect(first.result.current).toBe(true));
    first.unmount();
    resetPublicMembershipCache();

    // Status endpoint is now down (DB outage): every attempt 500s.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(errorResponse());
    const { result } = renderHook(() =>
      useStorefrontProEntitlement(PRO_SELLER)
    );
    // Cached entitlement applies as soon as effects run — styling never
    // flashes off.
    await waitFor(() => expect(result.current).toBe(true));
    // And survives after all retries are exhausted.
    await waitFor(
      () => expect(fetchMock).toHaveBeenCalledTimes(PRO_STATUS_MAX_ATTEMPTS),
      { timeout: 10000 }
    );
    expect(result.current).toBe(true);
  }, 15000);

  it("fails closed on terminal failure with no cached entitlement", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() =>
      useStorefrontProEntitlement(PRO_SELLER)
    );
    await waitFor(() => expect(result.current).toBe(false), {
      timeout: 10000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(PRO_STATUS_MAX_ATTEMPTS);
  }, 15000);

  it("ignores a cached entitlement older than the TTL", async () => {
    localStorage.setItem(
      `sf_pro_status:${PRO_SELLER}`,
      JSON.stringify({
        view: proView(PRO_SELLER, true),
        checkedAt: Date.now() - PRO_STATUS_LKG_TTL_MS - 1000,
      })
    );
    fetchMock.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() =>
      useStorefrontProEntitlement(PRO_SELLER)
    );
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(false), {
      timeout: 10000,
    });
  }, 15000);

  it("never applies one seller's cached entitlement to another seller", async () => {
    fetchMock.mockResolvedValue(okResponse(PRO_SELLER, true));
    const first = renderHook(() => useStorefrontProEntitlement(PRO_SELLER));
    await waitFor(() => expect(first.result.current).toBe(true));
    first.unmount();
    resetPublicMembershipCache();

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() =>
      useStorefrontProEntitlement(OTHER_SELLER)
    );
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(false), {
      timeout: 10000,
    });
  }, 15000);

  it("never leaks a Pro seller's entitlement across a client-side seller switch", async () => {
    // Seller A is verified Pro.
    fetchMock.mockResolvedValue(okResponse(PRO_SELLER, true));
    const { result, rerender } = renderHook(
      ({ pubkey }) => useStorefrontProEntitlement(pubkey),
      { initialProps: { pubkey: PRO_SELLER } }
    );
    await waitFor(() => expect(result.current).toBe(true));

    // Switch to seller B mid-session: no cache for B, and the status endpoint
    // is down so B's lookup only resolves after the full retry window.
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("network down"));
    rerender({ pubkey: OTHER_SELLER });

    // From the very first render of B, the previous seller's entitlement must
    // not apply.
    expect(result.current).not.toBe(true);
    await waitFor(() => expect(result.current).toBe(false), {
      timeout: 10000,
    });
  }, 15000);

  it("stays null without a pubkey and never fetches", () => {
    const { result } = renderHook(() => useStorefrontProEntitlement(""));
    expect(result.current).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores malformed cache entries", () => {
    localStorage.setItem(`sf_pro_status:${PRO_SELLER}`, "not-json");
    expect(readLastKnownGoodMembership(PRO_SELLER)).toBeNull();
    localStorage.setItem(
      `sf_pro_status:${PRO_SELLER}`,
      JSON.stringify({
        view: { ...proView(PRO_SELLER, true), isPro: "yes" },
        checkedAt: Date.now(),
      })
    );
    expect(readLastKnownGoodMembership(PRO_SELLER)).toBeNull();
    // A view recorded for a different pubkey must not leak.
    localStorage.setItem(
      `sf_pro_status:${PRO_SELLER}`,
      JSON.stringify({
        view: proView(OTHER_SELLER, true),
        checkedAt: Date.now(),
      })
    );
    expect(readLastKnownGoodMembership(PRO_SELLER)).toBeNull();
  });

  it("does not update state after unmount", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    fetchMock.mockImplementation(
      () => new Promise<Response>((res) => (resolveFetch = res))
    );
    const { unmount } = renderHook(() =>
      useStorefrontProEntitlement(PRO_SELLER)
    );
    unmount();
    // Resolving after unmount must not warn about state updates.
    await act(async () => {
      resolveFetch(okResponse(PRO_SELLER, true));
    });
  });
});
