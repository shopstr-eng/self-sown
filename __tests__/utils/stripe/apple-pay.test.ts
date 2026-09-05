/**
 * Apple Pay / payment-method domain registration. Per Stripe's
 * pmd-registration doc, Connect direct charges must register the checkout
 * domain on the CONNECTED account (Stripe-Account header); platform charges
 * register on the platform account. Both the legacy apple_pay/domains and
 * the newer payment_method_domains APIs are written, registration is
 * fail-open, and host trust is never request-controlled.
 */
const applePayCreate = jest.fn();
const pmdCreate = jest.fn();
jest.mock("stripe", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    applePayDomains: { create: applePayCreate },
    paymentMethodDomains: { create: pmdCreate },
  })),
}));

const getDomainByHostMock = jest.fn();
jest.mock("@/utils/db/custom-domains", () => ({
  getDomainByHost: (...args: unknown[]) => getDomainByHostMock(...args),
}));

import {
  normalizeRegistrableHost,
  registerApplePayDomain,
  trustedRegistrationHost,
} from "@/utils/stripe/apple-pay";

describe("normalizeRegistrableHost", () => {
  it("lowercases, strips ports, and rejects non-domains", () => {
    expect(normalizeRegistrableHost("SHOP.Example.com:443")).toBe(
      "shop.example.com"
    );
    expect(normalizeRegistrableHost("localhost:3000")).toBeNull();
    expect(normalizeRegistrableHost("nodots")).toBeNull();
    expect(normalizeRegistrableHost("")).toBeNull();
  });
});

describe("registerApplePayDomain", () => {
  beforeEach(() => {
    applePayCreate.mockReset().mockResolvedValue({});
    pmdCreate.mockReset().mockResolvedValue({});
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
  });

  it("registers on both domain APIs with the connected account header", async () => {
    await registerApplePayDomain("shop.example.com", "acct_123");
    expect(applePayCreate).toHaveBeenCalledWith(
      { domain_name: "shop.example.com" },
      { stripeAccount: "acct_123" }
    );
    expect(pmdCreate).toHaveBeenCalledWith(
      { domain_name: "shop.example.com" },
      { stripeAccount: "acct_123" }
    );
  });

  it("omits the account header for platform-account charges", async () => {
    await registerApplePayDomain("platform.example.com");
    expect(applePayCreate).toHaveBeenCalledWith(
      { domain_name: "platform.example.com" },
      undefined
    );
    expect(pmdCreate).toHaveBeenCalledWith(
      { domain_name: "platform.example.com" },
      undefined
    );
  });

  it("absorbs 'already registered' and caches the pair", async () => {
    applePayCreate.mockRejectedValue(new Error("Domain already registered"));
    pmdCreate.mockRejectedValue(
      new Error("You have already registered this domain")
    );
    await registerApplePayDomain("dupe.example.com", "acct_1");
    await registerApplePayDomain("dupe.example.com", "acct_1");
    expect(applePayCreate).toHaveBeenCalledTimes(1);
    expect(pmdCreate).toHaveBeenCalledTimes(1);
  });

  it("swallows transient failures, still attempts the other API, and does not cache", async () => {
    applePayCreate.mockRejectedValue(new Error("stripe 500"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await registerApplePayDomain("flaky.example.com", "acct_2");
    expect(pmdCreate).toHaveBeenCalledTimes(1);
    applePayCreate.mockResolvedValue({});
    await registerApplePayDomain("flaky.example.com", "acct_2");
    expect(applePayCreate).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("skips non-registrable hosts and missing keys entirely", async () => {
    await registerApplePayDomain("localhost:3000", "acct_3");
    delete process.env.STRIPE_SECRET_KEY;
    await registerApplePayDomain("nokey.example.com", "acct_3");
    expect(applePayCreate).not.toHaveBeenCalled();
    expect(pmdCreate).not.toHaveBeenCalled();
  });
});

describe("trustedRegistrationHost", () => {
  const SELLER = "ab".repeat(32);
  beforeEach(() => {
    getDomainByHostMock.mockReset().mockResolvedValue(null);
    process.env.NEXT_PUBLIC_BASE_URL = "https://milk.market";
  });

  it("trusts the platform host", async () => {
    await expect(trustedRegistrationHost("milk.market", SELLER)).resolves.toBe(
      "milk.market"
    );
  });

  it("trusts a verified custom domain owned by the seller", async () => {
    getDomainByHostMock.mockResolvedValue({ verified: true, pubkey: SELLER });
    await expect(
      trustedRegistrationHost("shop.example.com", SELLER)
    ).resolves.toBe("shop.example.com");
  });

  it("rejects unverified domains, other sellers' domains, and unknown hosts", async () => {
    getDomainByHostMock.mockResolvedValueOnce({
      verified: false,
      pubkey: SELLER,
    });
    await expect(
      trustedRegistrationHost("unverified.example.com", SELLER)
    ).resolves.toBeNull();
    getDomainByHostMock.mockResolvedValueOnce({
      verified: true,
      pubkey: "cd".repeat(32),
    });
    await expect(
      trustedRegistrationHost("someone-else.example.com", SELLER)
    ).resolves.toBeNull();
    await expect(
      trustedRegistrationHost("attacker.example.com", SELLER)
    ).resolves.toBeNull();
  });
});
