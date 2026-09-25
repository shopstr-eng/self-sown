import { resolveStorefrontRouteSlug } from "@/utils/storefront/storefront-route-slug";

const MAIN = { isCustomDomainVisit: false, ssrShopSlug: null };

describe("resolveStorefrontRouteSlug", () => {
  it("extracts the slug from direct stall URLs", () => {
    expect(
      resolveStorefrontRouteSlug({ asPath: "/stall/sunrise-farm", ...MAIN })
    ).toBe("sunrise-farm");
  });

  it("extracts the slug from rewritten nested stall URLs (listing/cart)", () => {
    // next.config rewrites /stall/<slug>/listing/<id> -> /listing/<id>: the
    // page route changes but asPath keeps the stall URL.
    expect(
      resolveStorefrontRouteSlug({
        asPath: "/stall/sunrise-farm/listing/abc123",
        ...MAIN,
      })
    ).toBe("sunrise-farm");
    expect(
      resolveStorefrontRouteSlug({
        asPath: "/stall/sunrise-farm/cart",
        ...MAIN,
      })
    ).toBe("sunrise-farm");
  });

  it("strips query strings and decodes encoded segments", () => {
    expect(
      resolveStorefrontRouteSlug({
        asPath: "/stall/sunrise-farm?ref=footer",
        ...MAIN,
      })
    ).toBe("sunrise-farm");
  });

  it("custom-domain subpages use the SSR shop slug, NOT the asPath segment", () => {
    // The proxy rewrites /blog/post -> /stall/<shop>/blog/post on a custom
    // domain, so pathname is /stall/** but asPath's first segment is a
    // content path, never a shop slug.
    expect(
      resolveStorefrontRouteSlug({
        asPath: "/blog/post",
        isCustomDomainVisit: true,
        ssrShopSlug: "real-shop",
      })
    ).toBe("real-shop");
    expect(
      resolveStorefrontRouteSlug({
        asPath: "/",
        isCustomDomainVisit: true,
        ssrShopSlug: "real-shop",
      })
    ).toBe("real-shop");
  });

  it("custom-domain visit without an SSR shop slug resolves nothing", () => {
    expect(
      resolveStorefrontRouteSlug({
        asPath: "/blog/post",
        isCustomDomainVisit: true,
        ssrShopSlug: null,
      })
    ).toBeNull();
  });

  it("non-stall routes on the main host resolve nothing", () => {
    expect(
      resolveStorefrontRouteSlug({ asPath: "/marketplace", ...MAIN })
    ).toBeNull();
    expect(resolveStorefrontRouteSlug({ asPath: "/", ...MAIN })).toBeNull();
    expect(
      resolveStorefrontRouteSlug({ asPath: "/stall/", ...MAIN })
    ).toBeNull();
  });
});
