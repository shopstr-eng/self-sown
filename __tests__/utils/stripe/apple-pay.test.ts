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
const pmdList = jest.fn();
jest.mock("stripe", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    paymentMethodDomains: {
      create: pmdCreate,
      validate: pmdValidate,
      list: pmdList,
    },
  })),
}));

const ACTIVE_PMD = {
  id: "pmd_1",
  enabled: true,
  apple_pay: { status: "active" },
};
const INACTIVE_PMD = {
  id: "pmd_1",
  enabled: true,
  apple_pay: { status: "inactive" },
};

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
    pmdCreate.mockReset().mockResolvedValue(ACTIVE_PMD);
    pmdValidate.mockReset().mockResolvedValue(ACTIVE_PMD);
    pmdList.mockReset().mockResolvedValue({ data: [] });
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
  });

  it("creates and caches an already-active domain on the connected account", async () => {
    await registerApplePayDomain("shop.example.com", "acct_123");
    expect(pmdCreate).toHaveBeenCalledWith(
      { domain_name: "shop.example.com" },
      { stripeAccount: "acct_123" }
    );
    // Active on create: no validation round-trip needed.
    expect(pmdValidate).not.toHaveBeenCalled();
    await registerApplePayDomain("shop.example.com", "acct_123");
    expect(pmdCreate).toHaveBeenCalledTimes(1);
  });

  it("validates a freshly created inactive domain", async () => {
    pmdCreate.mockResolvedValueOnce(INACTIVE_PMD);
    await registerApplePayDomain("newshop.example.com", "acct_123");
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
  });

  it("looks up duplicate registrations and caches only when active", async () => {
    pmdCreate.mockRejectedValue(
      new Error("You have already registered this domain")
    );
    pmdList.mockResolvedValue({ data: [ACTIVE_PMD] });
    await registerApplePayDomain("dupe.example.com", "acct_1");
    await registerApplePayDomain("dupe.example.com", "acct_1");
    expect(pmdCreate).toHaveBeenCalledTimes(1);
    expect(pmdList).toHaveBeenCalledWith(
      { domain_name: "dupe.example.com" },
      { stripeAccount: "acct_1" }
    );
    expect(pmdValidate).not.toHaveBeenCalled();
  });

  it("validates — and does not cache — a duplicate that stays inactive", async () => {
    const disabledPmd = {
      id: "pmd_9",
      enabled: false,
      apple_pay: { status: "inactive" },
    };
    pmdCreate.mockRejectedValue(
      new Error("You have already registered this domain")
    );
    pmdList.mockResolvedValue({ data: [disabledPmd] });
    pmdValidate.mockResolvedValue(disabledPmd);
    await registerApplePayDomain("disabled.example.com", "acct_2");
    expect(pmdValidate).toHaveBeenCalledWith("pmd_9", {
      stripeAccount: "acct_2",
    });
    await registerApplePayDomain("disabled.example.com", "acct_2");
    expect(pmdCreate).toHaveBeenCalledTimes(2);
  });

  it("swallows transient failures and does not cache (retried later)", async () => {
    pmdCreate.mockRejectedValue(new Error("stripe 500"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await registerApplePayDomain("flaky.example.com", "acct_3");
    await registerApplePayDomain("flaky.example.com", "acct_3");
    expect(pmdCreate).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("does not cache when validation fails", async () => {
    pmdCreate.mockResolvedValue(INACTIVE_PMD);
    pmdValidate.mockRejectedValue(new Error("validate down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await registerApplePayDomain("valflaky.example.com", "acct_9");
    await registerApplePayDomain("valflaky.example.com", "acct_9");
    expect(pmdCreate).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("skips non-registrable hosts and missing keys entirely", async () => {
    await registerApplePayDomain("localhost:3000", "acct_4");
    delete process.env.STRIPE_SECRET_KEY;
    await registerApplePayDomain("nokey.example.com", "acct_4");
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
