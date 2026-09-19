import {
  injectPageNavLinks,
  sanitizeStorefrontNavHref,
} from "@/utils/storefront-links";

describe("sanitizeStorefrontNavHref idempotence", () => {
  const page = { label: "About", href: "about", isPage: true };

  it("prefixes a bare page href with /stall/<slug>", () => {
    expect(sanitizeStorefrontNavHref(page, "naughtygoatco")).toBe(
      "/stall/naughtygoatco/about"
    );
  });

  it("does not double-prefix an already-prefixed stored href", () => {
    // Publish sanitizes once, render sanitizes again — a stored
    // /stall/<slug>/about must round-trip unchanged or every page nav link
    // 404s (/stall/<slug>/stall/<slug>/about).
    const once = sanitizeStorefrontNavHref(page, "naughtygoatco");
    const twice = sanitizeStorefrontNavHref(
      { ...page, href: once },
      "naughtygoatco"
    );
    expect(twice).toBe(once);
  });

  it("preserves query strings through both passes", () => {
    const once = sanitizeStorefrontNavHref(
      { label: "Sale", href: "about?x=1", isPage: true },
      "naughtygoatco"
    );
    expect(once).toBe("/stall/naughtygoatco/about?x=1");
    expect(
      sanitizeStorefrontNavHref({ label: "Sale", href: once, isPage: true }, "naughtygoatco")
    ).toBe(once);
  });

  it("still prefixes non-page relative hrefs", () => {
    expect(
      sanitizeStorefrontNavHref({ label: "About", href: "about" }, "naughtygoatco")
    ).toBe("/stall/naughtygoatco/about");
  });
});

describe("injectPageNavLinks", () => {
  const pages = [
    { slug: "about", title: "About Us" },
    { slug: "faq-page", title: "FAQ" },
  ];

  it("appends links for pages missing from the nav", () => {
    const links = injectPageNavLinks([{ label: "Home", href: "" }], pages, "shop");
    expect(links).toEqual([
      { label: "Home", href: "" },
      { label: "About Us", href: "about", isPage: true },
      { label: "FAQ", href: "faq-page", isPage: true },
    ]);
  });

  it("skips pages already linked, in either stored href form", () => {
    const existing = [
      { label: "About", href: "about", isPage: true },
      { label: "FAQ", href: "/stall/shop/faq-page", isPage: true },
    ];
    const result = injectPageNavLinks(existing, pages, "shop");
    expect(result).toHaveLength(2);
    expect(result).toEqual(existing);
  });

  it("does not mutate the input array", () => {
    const input = [{ label: "Home", href: "" }];
    injectPageNavLinks(input, pages, "shop");
    expect(input).toHaveLength(1);
  });

  it("is a no-op without pages", () => {
    const input = [{ label: "Home", href: "" }];
    expect(injectPageNavLinks(input, undefined, "shop")).toBe(input);
    expect(injectPageNavLinks(input, [], "shop")).toBe(input);
  });

  it("ignores non-page links when deduping", () => {
    const links = injectPageNavLinks(
      [{ label: "About externally", href: "https://example.com/about" }],
      [{ slug: "about", title: "About" }],
      "shop"
    );
    expect(links).toHaveLength(2);
  });
});
