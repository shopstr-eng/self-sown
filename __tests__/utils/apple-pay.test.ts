// Apple Pay domain registration util: registers each checkout domain with
// Stripe on the charge-owning account (connected account for direct charges,
// platform otherwise), caches account+domain pairs in-process, absorbs
// "already registered", and never throws into checkout.

const mockCreate = jest.fn();
const mockPmdCreate = jest.fn();

jest.mock("stripe", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    applePayDomains: { create: mockCreate },
    paymentMethodDomains: { create: mockPmdCreate },
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

const SELLER_A = "aaaa1111";
const SELLER_B = "bbbb2222";

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({});
  mockPmdCreate.mockResolvedValue({});
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.NEXT_PUBLIC_BASE_URL = "https://milk.market";
  mockGetDomainByHost.mockResolvedValue(null);
});

afterAll(() => {
  delete process.env.NEXT_PUBLIC_BASE_URL;
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

describe("trustedRegistrationHost", () => {
  it("accepts the platform host without any seller or domain lookup", async () => {
    await expect(
      trustedRegistrationHost("Milk.Market:443")
    ).resolves.toBe("milk.market");
    expect(mockGetDomainByHost).not.toHaveBeenCalled();
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
      trustedRegistrationHost("milk.market.evil.com", SELLER_A)
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
  it("registers on BOTH domain APIs of the platform account", async () => {
    await registerApplePayDomain("shop-a.test");
    expect(mockCreate).toHaveBeenCalledWith(
      { domain_name: "shop-a.test" },
      undefined
    );
    expect(mockPmdCreate).toHaveBeenCalledWith(
      { domain_name: "shop-a.test" },
      undefined
    );
  });

  it("registers on BOTH domain APIs of the connected account for direct charges", async () => {
    await registerApplePayDomain("shop-b.test", "acct_123");
    expect(mockCreate).toHaveBeenCalledWith(
      { domain_name: "shop-b.test" },
      { stripeAccount: "acct_123" }
    );
    expect(mockPmdCreate).toHaveBeenCalledWith(
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

  it("does not cache when paymentMethodDomains fails (legacy ok is not enough)", async () => {
    mockPmdCreate.mockRejectedValueOnce(new Error("pmd down"));
    await registerApplePayDomain("shop-g.test");
    // Legacy succeeded, but the pair must NOT be cached while the payment
    // method domains registration failed — the next checkout retries both.
    await registerApplePayDomain("shop-g.test");
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockPmdCreate).toHaveBeenCalledTimes(2);
    // Once both succeed the pair caches and later checkouts skip the API.
    await registerApplePayDomain("shop-g.test");
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockPmdCreate).toHaveBeenCalledTimes(2);
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
