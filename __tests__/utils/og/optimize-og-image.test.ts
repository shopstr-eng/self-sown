import {
  toOptimizedOgImageUrl,
  resolveOgImageOrigin,
} from "@/utils/og/optimize-og-image";

describe("toOptimizedOgImageUrl", () => {
  it("wraps an absolute https image URL in the og-image proxy", () => {
    expect(
      toOptimizedOgImageUrl(
        "https://cdn.example.com/banner.png",
        "https://naughtygoat.co"
      )
    ).toBe(
      "https://naughtygoat.co/api/og-image?url=https%3A%2F%2Fcdn.example.com%2Fbanner.png"
    );
  });

  it("is idempotent for already-proxied URLs", () => {
    const wrapped =
      "https://milk.market/api/og-image?url=https%3A%2F%2Fcdn.example.com%2Fbanner.png";
    expect(toOptimizedOgImageUrl(wrapped, "https://milk.market")).toBe(wrapped);
  });

  it("leaves relative paths untouched (callers absolute-ize first)", () => {
    expect(
      toOptimizedOgImageUrl("/milk-market.png", "https://milk.market")
    ).toBe("/milk-market.png");
  });

  it("leaves data URLs untouched (cannot be proxied)", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    expect(toOptimizedOgImageUrl(dataUrl, "https://milk.market")).toBe(dataUrl);
  });

  it("passes through empty input and tolerates a trailing-slash origin", () => {
    expect(toOptimizedOgImageUrl("", "https://milk.market")).toBe("");
    expect(
      toOptimizedOgImageUrl(
        "https://cdn.example.com/a.png",
        "https://milk.market/"
      )
    ).toBe(
      "https://milk.market/api/og-image?url=https%3A%2F%2Fcdn.example.com%2Fa.png"
    );
  });
});

describe("resolveOgImageOrigin", () => {
  it("uses the seller's domain from the SSR store URL on custom domains", () => {
    expect(resolveOgImageOrigin("https://naughtygoat.co/products", true)).toBe(
      "https://naughtygoat.co"
    );
  });

  it("uses the platform origin from a platform stall URL", () => {
    expect(resolveOgImageOrigin("https://milk.market/stall/farm", false)).toBe(
      "https://milk.market"
    );
  });

  it("falls back to the live origin on custom domains without an SSR URL", () => {
    // jsdom provides window.location.origin.
    expect(resolveOgImageOrigin(undefined, true)).toBe(window.location.origin);
  });

  it("falls back to the platform base otherwise", () => {
    expect(resolveOgImageOrigin(undefined, false)).toBe("https://milk.market");
    expect(resolveOgImageOrigin("", false)).toBe("https://milk.market");
  });

  it("ignores an unparseable SSR store URL", () => {
    expect(resolveOgImageOrigin("not a url", false)).toBe(
      "https://milk.market"
    );
  });
});
