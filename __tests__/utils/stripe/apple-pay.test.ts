/**
 * Apple Pay payment-method domain registration. Per Stripe's
 * pmd-registration doc, Connect direct charges must register the checkout
 * domain on the CONNECTED account (Stripe-Account header); platform charges
 * register on the platform account. Registration is PMD-only (create +
 * validate — Stripe handles Apple's merchant validation, no hosted
 * association file), fail-open, and host trust is never request-controlled.
 */
const pmdCreate = jest.fn();
const pmdValidate = jest.fn();
jest.mock("stripe", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    paymentMethodDomains: { create: pmdCreate, validate: pmdValidate },
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
    pmdCreate.mockReset().mockResolvedValue({ id: "pmd_1" });
    pmdValidate.mockReset().mockResolvedValue({});
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
  });

  it("creates and validates a payment method domain on the connected account", async () => {
    await registerApplePayDomain("shop.example.com", "acct_123");
    expect(pmdCreate).toHaveBeenCalledWith(
      { domain_name: "shop.example.com" },
      { stripeAccount: "acct_123" }
    );
    expect(pmdValidate).toHaveBeenCalledWith("pmd_1", {
      stripeAccount: "acct_123",
    });
  });

  it("omits the account header for platform-account charges", async () => {
    await registerApplePayDomain("platform.example.com");
    expect(pmdCreate).toHaveBeenCalledWith(
      { domain_name: "platform.example.com" },
      undefined
    );
    expect(pmdValidate).toHaveBeenCalledWith("pmd_1", undefined);
  });

  it("absorbs 'already registered' (no id, no validate) and caches the pair", async () => {
    pmdCreate.mockRejectedValue(
      new Error("You have already registered this domain")
    );
    await registerApplePayDomain("dupe.example.com", "acct_1");
    await registerApplePayDomain("dupe.example.com", "acct_1");
    expect(pmdCreate).toHaveBeenCalledTimes(1);
    expect(pmdValidate).not.toHaveBeenCalled();
  });

  it("swallows transient failures and does not cache (retried later)", async () => {
    pmdCreate.mockRejectedValue(new Error("stripe 500"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await registerApplePayDomain("flaky.example.com", "acct_2");
    await registerApplePayDomain("flaky.example.com", "acct_2");
    expect(pmdCreate).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("still caches when validate fails (activation is best-effort)", async () => {
    pmdValidate.mockRejectedValue(new Error("validate down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await registerApplePayDomain("valflaky.example.com", "acct_9");
    await registerApplePayDomain("valflaky.example.com", "acct_9");
    expect(pmdCreate).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("skips non-registrable hosts and missing keys entirely", async () => {
    await registerApplePayDomain("localhost:3000", "acct_3");
    delete process.env.STRIPE_SECRET_KEY;
    await registerApplePayDomain("nokey.example.com", "acct_3");
    expect(pmdCreate).not.toHaveBeenCalled();
  });
});

describe("trustedRegistrationHost", () => {
  const SELLER = "ab".repeat(32);
  beforeEach(() => {
    getDomainByHostMock.mockReset().mockResolvedValue(null);
    process.env.NEXT_PUBLIC_BASE_URL = "https://platform.example.com";
  });

  it("rejects the platform marketplace host (Apple Pay disabled there)", async () => {
    await expect(
      trustedRegistrationHost("platform.example.com", SELLER)
    ).resolves.toBeNull();
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
