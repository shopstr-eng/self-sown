import {
  toOptimizedOgImageUrl,
  resolveOgImageOrigin,
} from "@/utils/og/optimize-og-image";
import { SITE_URL } from "@/utils/site-url";

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
    const wrapped = `${SITE_URL}/api/og-image?url=https%3A%2F%2Fcdn.example.com%2Fbanner.png`;
    expect(toOptimizedOgImageUrl(wrapped, SITE_URL)).toBe(wrapped);
  });

  it("leaves relative paths untouched (callers absolute-ize first)", () => {
    expect(
      toOptimizedOgImageUrl("/milk-market.png", SITE_URL)
    ).toBe("/milk-market.png");
  });

  it("leaves data URLs untouched (cannot be proxied)", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    expect(toOptimizedOgImageUrl(dataUrl, SITE_URL)).toBe(dataUrl);
  });

  it("passes through empty input and tolerates a trailing-slash origin", () => {
    expect(toOptimizedOgImageUrl("", SITE_URL)).toBe("");
    expect(
      toOptimizedOgImageUrl(
        "https://cdn.example.com/a.png",
        `${SITE_URL}/`
      )
    ).toBe(
      `${SITE_URL}/api/og-image?url=https%3A%2F%2Fcdn.example.com%2Fa.png`
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
    expect(resolveOgImageOrigin(`${SITE_URL}/stall/farm`, false)).toBe(
      SITE_URL
    );
  });

  it("falls back to the live origin on custom domains without an SSR URL", () => {
    // jsdom provides window.location.origin.
    expect(resolveOgImageOrigin(undefined, true)).toBe(window.location.origin);
  });

  it("falls back to the platform base otherwise", () => {
    expect(resolveOgImageOrigin(undefined, false)).toBe(SITE_URL);
    expect(resolveOgImageOrigin("", false)).toBe(SITE_URL);
  });

  it("ignores an unparseable SSR store URL", () => {
    expect(resolveOgImageOrigin("not a url", false)).toBe(
      SITE_URL
    );
  });
});
