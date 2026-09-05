// Apple Pay domain registration util: registers each checkout domain with
// Stripe on the charge-owning account (connected account for direct charges,
// platform otherwise), caches account+domain pairs in-process, absorbs
// "already registered", and never throws into checkout.

const mockCreate = jest.fn();

jest.mock("stripe", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    applePayDomains: { create: mockCreate },
  })),
}));

import {
  registerApplePayDomain,
  normalizeRegistrableHost,
} from "@/utils/stripe/apple-pay";

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({});
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
});

describe("normalizeRegistrableHost", () => {
  it("strips ports and lowercases real domains", () => {
    expect(normalizeRegistrableHost("Milk.Market:443")).toBe("milk.market");
  });

  it("rejects localhost and bare hosts Apple can never verify", () => {
    expect(normalizeRegistrableHost("localhost:3000")).toBeNull();
    expect(normalizeRegistrableHost("")).toBeNull();
  });
});

describe("registerApplePayDomain", () => {
  it("registers on the platform account when no connected account is given", async () => {
    await registerApplePayDomain("shop-a.test");
    expect(mockCreate).toHaveBeenCalledWith(
      { domain_name: "shop-a.test" },
      undefined
    );
  });

  it("registers on the connected account for direct charges", async () => {
    await registerApplePayDomain("shop-b.test", "acct_123");
    expect(mockCreate).toHaveBeenCalledWith(
      { domain_name: "shop-b.test" },
      { stripeAccount: "acct_123" }
    );
  });

  it("caches account+domain pairs so repeat checkouts skip the API", async () => {
    await registerApplePayDomain("shop-c.test", "acct_1");
    await registerApplePayDomain("shop-c.test", "acct_1");
    await registerApplePayDomain("shop-c.test", "acct_2");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("treats 'already registered' as success and caches it", async () => {
    mockCreate.mockRejectedValueOnce(new Error("Domain is already registered"));
    await registerApplePayDomain("shop-d.test");
    await registerApplePayDomain("shop-d.test");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("swallows other Stripe failures without caching (retried later)", async () => {
    mockCreate.mockRejectedValue(new Error("stripe down"));
    await expect(
      registerApplePayDomain("shop-e.test")
    ).resolves.toBeUndefined();
    await registerApplePayDomain("shop-e.test");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("skips hosts that cannot be registered", async () => {
    await registerApplePayDomain("localhost:3000");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("does nothing without a Stripe secret key", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await registerApplePayDomain("shop-f.test");
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
