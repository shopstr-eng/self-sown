import {
  isSelfHostBlockedPage,
  isSelfHostBlockedApi,
  selfHostStallRewritePath,
  selfHostHeaderTrusted,
  SELF_HOST_CONNECT_ALLOW,
} from "@/utils/self-host/routing";

describe("isSelfHostBlockedPage", () => {
  it("blocks marketplace, pro-billing, communities, and discovery shortcuts", () => {
    for (const p of [
      "/marketplace",
      "/marketplace/category/dairy",
      "/pro",
      "/pro/checkout",
      "/communities",
      "/communities/abc",
      "/npub1abc123",
      "/naddr1abc123",
    ]) {
      expect(isSelfHostBlockedPage(p)).toBe(true);
    }
  });

  it("blocks the platform marketing, info, and legal/policy pages", () => {
    for (const p of [
      "/about",
      "/about/team",
      "/faq",
      "/producer-guide",
      "/producer-guide/raw-milk",
      "/contact",
      "/contact/success",
      "/terms",
      "/terms/",
      "/privacy",
      "/privacy/cookies",
    ]) {
      expect(isSelfHostBlockedPage(p)).toBe(true);
    }
  });

  it("does NOT block the storefront and its sub-pages", () => {
    for (const p of [
      "/",
      "/cart",
      "/checkout",
      "/listing/some-product",
      "/shop/my-farm",
      "/stall/my-farm",
      "/settings",
      "/settings/self-host",
      "/orders",
      "/wallet",
      "/auth/sign-in",
    ]) {
      expect(isSelfHostBlockedPage(p)).toBe(false);
    }
  });

  it("matches blocked pages on an exact-or-subpath boundary, not a bare prefix", () => {
    // A different route that merely begins with the same letters must stay live.
    for (const p of [
      "/aboutus",
      "/contacts",
      "/privacy-policy",
      "/terms-and-conditions",
      "/faqs",
    ]) {
      expect(isSelfHostBlockedPage(p)).toBe(false);
    }
  });

  it("does not treat a normal path that merely starts with npub-like text as discovery", () => {
    // The discovery matcher anchors on the full path; nested paths are fine.
    expect(isSelfHostBlockedPage("/listing/npub-themed-cheese")).toBe(false);
  });
});

describe("isSelfHostBlockedApi", () => {
  it("blocks platform billing APIs", () => {
    for (const p of [
      "/api/pro/create-lifetime",
      "/api/pro/create-subscription",
      "/api/pro/cancel",
      "/api/pro/manual-invoice",
      "/api/pro/confirm-invoice",
      "/api/pro/verify-invoice",
    ]) {
      expect(isSelfHostBlockedApi(p)).toBe(true);
    }
  });

  it("blocks all Stripe Connect APIs except the seller-status read", () => {
    expect(isSelfHostBlockedApi("/api/stripe/connect/create-account")).toBe(
      true
    );
    expect(isSelfHostBlockedApi("/api/stripe/connect/process-transfers")).toBe(
      true
    );
    expect(isSelfHostBlockedApi(SELF_HOST_CONNECT_ALLOW)).toBe(false);
  });

  it("keeps the export, status, payment, and non-billing APIs live", () => {
    for (const p of [
      "/api/pro/export-store",
      "/api/pro/status",
      "/api/stripe/create-payment-intent",
      "/api/mcp",
      "/api/orders",
    ]) {
      expect(isSelfHostBlockedApi(p)).toBe(false);
    }
  });

  it("ignores non-API paths", () => {
    expect(isSelfHostBlockedApi("/marketplace")).toBe(false);
    expect(isSelfHostBlockedApi("/")).toBe(false);
  });
});

describe("selfHostHeaderTrusted", () => {
  it("trusts the header only when the server is itself in self-host mode", () => {
    for (const env of ["1", "true", "TRUE", "yes", "on", " On "]) {
      expect(selfHostHeaderTrusted(env, "1")).toBe(true);
    }
  });

  it("ignores a spoofed header on the hosted platform (MM_SELF_HOST unset)", () => {
    // The core regression guard: a crafted x-mm-self-host:1 on hosted mode must
    // NOT flip forceSelfHostChrome and bypass the Pro render gate.
    for (const env of [undefined, "", "0", "false", "no", "off"]) {
      expect(selfHostHeaderTrusted(env, "1")).toBe(false);
    }
  });

  it("is false when the header is absent even on a self-host server", () => {
    for (const header of [null, "0", "true", "yes"]) {
      expect(selfHostHeaderTrusted("1", header)).toBe(false);
    }
  });
});

describe("selfHostStallRewritePath", () => {
  it("rewrites root to the tenant stall", () => {
    expect(selfHostStallRewritePath("/", "my-farm")).toBe("/stall/my-farm");
    expect(selfHostStallRewritePath("", "my-farm")).toBe("/stall/my-farm");
  });

  it("prefixes sub-paths under the tenant stall", () => {
    expect(selfHostStallRewritePath("/cart", "my-farm")).toBe(
      "/stall/my-farm/cart"
    );
    expect(selfHostStallRewritePath("/listing/x", "my-farm")).toBe(
      "/stall/my-farm/listing/x"
    );
  });
});
