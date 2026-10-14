/** @jest-environment node */

// apps/mobile/lib/api-base-url.ts reads the RN global __DEV__.
(globalThis as { __DEV__?: boolean }).__DEV__ = true;

jest.mock("react-native", () => ({ Platform: { OS: "web" } }), {
  virtual: true,
});

jest.mock(
  "expo-linking",
  () => ({
    createURL: (
      path: string,
      options?: { scheme?: string; queryParams?: Record<string, string> }
    ) => {
      const scheme = options?.scheme ?? "selfsown";
      const query = options?.queryParams
        ? "?" +
          Object.entries(options.queryParams)
            .map(([key, value]) => `${key}=${value}`)
            .join("&")
        : "";
      return `${scheme}:/${path}${query}`;
    },
    parse: (_url: string) => ({ queryParams: {} }),
  }),
  { virtual: true }
);

// Deterministic stand-in for the real signer: echoes the proof template tags
// so tests can assert exactly what the request binds.
jest.mock(
  "@self-sown/nostr",
  () => ({
    signEventTemplate: (
      session: { pubkey: string },
      template: { tags: string[][] }
    ) => ({
      id: "signed",
      pubkey: session.pubkey,
      kind: 27235,
      tags: template.tags,
    }),
  }),
  { virtual: true }
);

import {
  createProCheckoutRedirectBaseUrl,
  createProCheckoutRedirectUrl,
  createProCheckoutSession,
  createProPortalSession,
  describeMembership,
  getMobileMembershipView,
  getProCheckoutCallbackStatus,
  membershipOffers,
  type MobileMembershipView,
} from "@/apps/mobile/lib/pro-membership";
import type { SellerSession } from "@self-sown/domain";

const session = {
  pubkey: "c".repeat(64),
  nsec: "nsec1test",
} as unknown as SellerSession;

const fetchMock = jest.fn();
(globalThis as { fetch?: unknown }).fetch = fetchMock;

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("getMobileMembershipView", () => {
  it("reads the public status endpoint for the seller pubkey", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ pubkey: session.pubkey, status: "active", isPro: true })
    );

    const view = await getMobileMembershipView(session.pubkey);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        `/api/pro/status?pubkey=${encodeURIComponent(session.pubkey)}`
      )
    );
    expect(view.isPro).toBe(true);
  });

  it("throws the server error message when the status load fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, false, 500));
    await expect(getMobileMembershipView(session.pubkey)).rejects.toThrow(
      "boom"
    );
  });
});

describe("createProCheckoutSession", () => {
  it("posts a signed proof binding action, path, pubkey, and plan", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ url: "https://checkout.stripe.com/c/pay/cs_1" })
    );

    const result = await createProCheckoutSession(session, "yearly");

    expect(result.url).toBe("https://checkout.stripe.com/c/pay/cs_1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/pro/checkout-session");
    expect(init.method).toBe("POST");

    const signedHeader = JSON.parse(
      (init.headers as Record<string, string>)["x-signed-event"] as string
    );
    expect(signedHeader.tags).toEqual(
      expect.arrayContaining([
        ["action", "create_pro_checkout_session"],
        ["method", "POST"],
        ["path", "/api/pro/checkout-session"],
        ["pubkey", session.pubkey],
        ["plan", "yearly"],
      ])
    );

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      pubkey: session.pubkey,
      plan: "yearly",
      successUrl: "selfsown://pro-return?status=success",
      cancelUrl: "selfsown://pro-return?status=cancel",
    });
  });
});

describe("createProPortalSession", () => {
  it("posts a signed proof bound to the portal-session action", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ url: "https://billing.stripe.com/p/session/1" })
    );

    await createProPortalSession(session);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const signedHeader = JSON.parse(
      (init.headers as Record<string, string>)["x-signed-event"] as string
    );
    expect(signedHeader.tags).toEqual(
      expect.arrayContaining([
        ["action", "create_pro_portal_session"],
        ["path", "/api/pro/portal-session"],
        ["pubkey", session.pubkey],
      ])
    );
  });
});

describe("redirect URLs", () => {
  it("deep-link back into the app with a status param", () => {
    expect(createProCheckoutRedirectUrl("success")).toBe(
      "selfsown://pro-return?status=success"
    );
    expect(createProCheckoutRedirectUrl("cancel")).toBe(
      "selfsown://pro-return?status=cancel"
    );
    expect(createProCheckoutRedirectBaseUrl()).toBe("selfsown://pro-return");
  });
});

describe("getProCheckoutCallbackStatus", () => {
  it("distinguishes a paid checkout from a canceled one", () => {
    expect(
      getProCheckoutCallbackStatus("selfsown://pro-return?status=success")
    ).toBe("success");
    expect(
      getProCheckoutCallbackStatus("selfsown://pro-return?status=cancel")
    ).toBe("cancel");
  });

  it("tolerates the three-slash custom-scheme form some platforms produce", () => {
    expect(
      getProCheckoutCallbackStatus("selfsown:///pro-return?status=success")
    ).toBe("success");
    expect(
      getProCheckoutCallbackStatus("selfsown:///pro-return?status=cancel")
    ).toBe("cancel");
  });

  it("returns null when no status can be determined", () => {
    expect(getProCheckoutCallbackStatus("selfsown://pro-return")).toBeNull();
    expect(
      getProCheckoutCallbackStatus("selfsown://pro-return?x=1")
    ).toBeNull();
    expect(getProCheckoutCallbackStatus(null)).toBeNull();
    expect(getProCheckoutCallbackStatus(undefined)).toBeNull();
  });
});

describe("membershipOffers", () => {
  const base: MobileMembershipView = {
    pubkey: session.pubkey,
    status: "free",
    isPro: false,
    isTrialing: false,
    isLifetime: false,
    billingMethod: null,
    term: null,
    trialEnd: null,
    currentPeriodEnd: null,
    graceUntil: null,
    cancelAtPeriodEnd: false,
  };

  it("offers every plan to free and lapsed sellers", () => {
    expect(membershipOffers(base)).toEqual({
      subscriptionPlans: true,
      lifetime: true,
      portal: false,
    });
    expect(membershipOffers({ ...base, status: "readonly" })).toEqual({
      subscriptionPlans: true,
      lifetime: true,
      portal: false,
    });
  });

  it("lets trial members add payment before the trial ends", () => {
    expect(
      membershipOffers({
        ...base,
        status: "trialing",
        isPro: true,
        isTrialing: true,
      })
    ).toEqual({ subscriptionPlans: true, lifetime: true, portal: false });
  });

  it("offers active subscribers only the lifetime upgrade plus the portal", () => {
    expect(
      membershipOffers({
        ...base,
        status: "active",
        isPro: true,
        billingMethod: "stripe",
        term: "monthly",
      })
    ).toEqual({ subscriptionPlans: false, lifetime: true, portal: true });
  });

  it("keeps the portal available while a past-due subscription is in grace", () => {
    expect(
      membershipOffers({
        ...base,
        status: "grace",
        isPro: true,
        billingMethod: "stripe",
        term: "monthly",
      })
    ).toEqual({ subscriptionPlans: false, lifetime: true, portal: true });
  });

  it("offers manual (non-Stripe) members the lifetime upgrade without a portal", () => {
    expect(
      membershipOffers({
        ...base,
        status: "active",
        isPro: true,
        billingMethod: "manual",
        term: "yearly",
      })
    ).toEqual({ subscriptionPlans: false, lifetime: true, portal: false });
  });

  it("offers lifetime members nothing", () => {
    expect(
      membershipOffers({
        ...base,
        status: "active",
        isPro: true,
        isLifetime: true,
      })
    ).toEqual({ subscriptionPlans: false, lifetime: false, portal: false });
  });
});

describe("describeMembership", () => {
  const base: MobileMembershipView = {
    pubkey: session.pubkey,
    status: "free",
    isPro: false,
    isTrialing: false,
    isLifetime: false,
    billingMethod: null,
    term: null,
    trialEnd: null,
    currentPeriodEnd: null,
    graceUntil: null,
    cancelAtPeriodEnd: false,
  };

  it("describes lifetime access as Wrangler with no renewal", () => {
    const summary = describeMembership({
      ...base,
      isLifetime: true,
      status: "active",
    });
    expect(summary.label).toBe("Wrangler lifetime");
    expect(summary.tone).toBe("success");
  });

  it("describes an active yearly subscription", () => {
    const summary = describeMembership({
      ...base,
      status: "active",
      isPro: true,
      term: "yearly",
      billingMethod: "stripe",
      currentPeriodEnd: "2026-11-01T00:00:00.000Z",
    });
    expect(summary.label).toBe("Herd — yearly");
    expect(summary.detail).toContain("Renews");
  });

  it("surfaces a pending cancellation with the end date", () => {
    const summary = describeMembership({
      ...base,
      status: "active",
      isPro: true,
      term: "monthly",
      billingMethod: "stripe",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: "2026-11-01T00:00:00.000Z",
    });
    expect(summary.detail).toContain("Canceled");
  });

  it("flags grace as a warning and lapsed states as danger", () => {
    expect(describeMembership({ ...base, status: "grace" }).tone).toBe(
      "warning"
    );
    expect(describeMembership({ ...base, status: "readonly" }).tone).toBe(
      "danger"
    );
    expect(describeMembership({ ...base, status: "hidden" }).tone).toBe(
      "danger"
    );
  });

  it("describes free accounts with an upgrade prompt", () => {
    const summary = describeMembership(base);
    expect(summary.label).toBe("Free");
    expect(summary.tone).toBe("neutral");
  });
});
