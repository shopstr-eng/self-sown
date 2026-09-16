// Apple Pay domain registration util: registers each checkout domain with
// Stripe on the charge-owning account (connected account for direct charges,
// platform otherwise), caches account+domain pairs in-process, absorbs
// "already registered", and never throws into checkout.

const mockPmdCreate = jest.fn();
const mockPmdValidate = jest.fn();

jest.mock("stripe", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    paymentMethodDomains: {
      create: mockPmdCreate,
      validate: mockPmdValidate,
    },
  })),
}));

jest.mock("@/utils/db/custom-domains", () => ({
  getDomainByHost: jest.fn(),
}));

import {
  registerApplePayDomain,
  normalizeRegistrableHost,
  trustedRegistrationHost,
} from "@/utils/stripe/apple-pay";
import { getDomainByHost } from "@/utils/db/custom-domains";

const mockGetDomainByHost = getDomainByHost as jest.Mock;

import { __resetSelfHostConfigCacheForTests } from "@/utils/self-host/config";

const SELLER_A = "aaaa1111";
const SELLER_B = "bbbb2222";

beforeEach(() => {
  jest.clearAllMocks();
  mockPmdCreate.mockResolvedValue({ id: "pmd_1" });
  mockPmdValidate.mockResolvedValue({});
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.NEXT_PUBLIC_BASE_URL = "https://platform.example.com";
  mockGetDomainByHost.mockResolvedValue(null);
});

afterAll(() => {
  delete process.env.NEXT_PUBLIC_BASE_URL;
});

describe("normalizeRegistrableHost", () => {
  it("strips ports and lowercases real domains", () => {
    expect(normalizeRegistrableHost("Platform.Example.com:443")).toBe(
      "platform.example.com"
    );
  });

  it("rejects localhost and bare hosts Apple can never verify", () => {
    expect(normalizeRegistrableHost("localhost:3000")).toBeNull();
    expect(normalizeRegistrableHost("")).toBeNull();
  });
});

describe("trustedRegistrationHost", () => {
  it("rejects the platform marketplace host (Apple Pay disabled there)", async () => {
    await expect(
      trustedRegistrationHost("Platform.Example.com:443")
    ).resolves.toBeNull();
    expect(mockGetDomainByHost).not.toHaveBeenCalled();
  });

  it("trusts the configured base host on a self-host instance", async () => {
    process.env.SS_SELF_HOST = "1";
    __resetSelfHostConfigCacheForTests();
    try {
      await expect(
        trustedRegistrationHost("Platform.Example.com:443")
      ).resolves.toBe("platform.example.com");
      expect(mockGetDomainByHost).not.toHaveBeenCalled();
    } finally {
      delete process.env.SS_SELF_HOST;
      __resetSelfHostConfigCacheForTests();
    }
  });

  it("rejects an unverified custom domain even when owned by the requesting seller", async () => {
    mockGetDomainByHost.mockResolvedValue({
      pubkey: SELLER_A,
      domain: "shop.example.com",
      verified: false,
    });
    await expect(
      trustedRegistrationHost("shop.example.com", SELLER_A)
    ).resolves.toBeNull();
  });

  it("rejects a verified domain owned by a DIFFERENT seller", async () => {
    mockGetDomainByHost.mockResolvedValue({
      pubkey: SELLER_B,
      domain: "shop.example.com",
      verified: true,
    });
    await expect(
      trustedRegistrationHost("shop.example.com", SELLER_A)
    ).resolves.toBeNull();
  });

  it("accepts a verified domain owned by the requesting seller", async () => {
    mockGetDomainByHost.mockResolvedValue({
      pubkey: SELLER_A,
      domain: "shop.example.com",
      verified: true,
    });
    await expect(
      trustedRegistrationHost("shop.example.com", SELLER_A)
    ).resolves.toBe("shop.example.com");
  });

  it("rejects spoofed/garbage hosts that match nothing", async () => {
    await expect(
      trustedRegistrationHost("evil.example.com", SELLER_A)
    ).resolves.toBeNull();
    await expect(
      trustedRegistrationHost(undefined, SELLER_A)
    ).resolves.toBeNull();
    await expect(
      trustedRegistrationHost("localhost:3000", SELLER_A)
    ).resolves.toBeNull();
    await expect(
      trustedRegistrationHost("platform.example.com.evil.com", SELLER_A)
    ).resolves.toBeNull();
  });

  it("fails closed when the domain lookup throws", async () => {
    mockGetDomainByHost.mockRejectedValue(new Error("db down"));
    await expect(
      trustedRegistrationHost("shop.example.com", SELLER_A)
    ).resolves.toBeNull();
  });
});

describe("registerApplePayDomain", () => {
  it("creates and validates a payment method domain on the platform account", async () => {
    await registerApplePayDomain("shop-a.test");
    expect(mockPmdCreate).toHaveBeenCalledWith(
      { domain_name: "shop-a.test" },
      undefined
    );
    expect(mockPmdValidate).toHaveBeenCalledWith("pmd_1", undefined);
  });

  it("registers on the connected account for direct charges", async () => {
    await registerApplePayDomain("shop-b.test", "acct_123");
    expect(mockPmdCreate).toHaveBeenCalledWith(
      { domain_name: "shop-b.test" },
      { stripeAccount: "acct_123" }
    );
    expect(mockPmdValidate).toHaveBeenCalledWith("pmd_1", {
      stripeAccount: "acct_123",
    });
  });

  it("caches account+domain pairs so repeat checkouts skip the API", async () => {
    await registerApplePayDomain("shop-c.test", "acct_1");
    await registerApplePayDomain("shop-c.test", "acct_1");
    await registerApplePayDomain("shop-c.test", "acct_2");
    expect(mockPmdCreate).toHaveBeenCalledTimes(2);
  });

  it("treats 'already registered' as success (cached, no validate — no id)", async () => {
    mockPmdCreate.mockRejectedValueOnce(
      new Error("You have already registered this domain")
    );
    await registerApplePayDomain("shop-d.test");
    await registerApplePayDomain("shop-d.test");
    expect(mockPmdCreate).toHaveBeenCalledTimes(1);
    expect(mockPmdValidate).not.toHaveBeenCalled();
  });

  it("swallows other Stripe failures without caching (retried later)", async () => {
    mockPmdCreate.mockRejectedValue(new Error("stripe down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      registerApplePayDomain("shop-e.test")
    ).resolves.toBeUndefined();
    await registerApplePayDomain("shop-e.test");
    expect(mockPmdCreate).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("still caches when validate fails (activation is best-effort)", async () => {
    mockPmdValidate.mockRejectedValueOnce(new Error("validate down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    await registerApplePayDomain("shop-g.test");
    await registerApplePayDomain("shop-g.test");
    expect(mockPmdCreate).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("skips hosts that cannot be registered", async () => {
    await registerApplePayDomain("localhost:3000");
    expect(mockPmdCreate).not.toHaveBeenCalled();
  });

  it("does nothing without a Stripe secret key", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await registerApplePayDomain("shop-f.test");
    expect(mockPmdCreate).not.toHaveBeenCalled();
  });
});
