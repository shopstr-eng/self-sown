import {
  buildSellerShopProfileContent,
  normalizeStorefrontSlug,
  parseSellerShopProfileEvent,
  selectSellerListingSummaries,
  validateStorefrontBasicsDraft,
} from "../index";

describe("seller domain helpers", () => {
  test("validates storefront basics draft fields", () => {
    expect(
      validateStorefrontBasicsDraft({
        shopName: "",
        about: "a".repeat(501),
        notificationEmail: "invalid-email",
        shopSlug: "!",
      })
    ).toEqual({
      shopName: "Shop name is required.",
      about: "About must be 500 characters or fewer.",
      notificationEmail: "Enter a valid email address.",
      shopSlug: "Shop slug must be at least 2 characters.",
    });
  });

  test("builds storefront content while preserving existing seller settings", () => {
    expect(
      buildSellerShopProfileContent({
        pubkey: "seller-pubkey",
        existingContent: {
          name: "Old Name",
          about: "Old about",
          ui: {
            picture: "https://example.com/logo.png",
            banner: "https://example.com/banner.png",
            theme: "olive",
            darkMode: false,
          },
          merchants: ["seller-pubkey"],
          freeShippingThreshold: 80,
          freeShippingCurrency: "USD",
          paymentMethodDiscounts: { cashu: 10 },
          storefront: {
            shopSlug: "old-slug",
          },
        },
        draft: {
          shopName: "Fresh Farm",
          about: "Grass-fed milk and cheese.",
          notificationEmail: "seller@example.com",
          shopSlug: " Fresh Farm!! ",
        },
      })
    ).toEqual({
      name: "Fresh Farm",
      about: "Grass-fed milk and cheese.",
      ui: {
        picture: "https://example.com/logo.png",
        banner: "https://example.com/banner.png",
        theme: "olive",
        darkMode: false,
      },
      merchants: ["seller-pubkey"],
      freeShippingThreshold: 80,
      freeShippingCurrency: "USD",
      paymentMethodDiscounts: { cashu: 10 },
      storefront: {
        shopSlug: "fresh-farm",
      },
    });
  });

  test("normalizes storefront slugs without leaving a trailing dash after truncation", () => {
    expect(normalizeStorefrontSlug(`${"a".repeat(62)}!!`)).toBe("a".repeat(62));
  });

  test("parses storefront config defensively from malformed profile content", () => {
    expect(
      parseSellerShopProfileEvent({
        id: "shop-event",
        pubkey: "seller-pubkey",
        created_at: 1710000000,
        kind: 30019,
        sig: "sig",
        tags: [["d", "seller-pubkey"]],
        content: JSON.stringify({
          name: "Fresh Farm",
          about: "Milk and cheese.",
          storefront: {
            shopSlug: "fresh-farm",
            productLayout: "grid",
            navLinks: [{ label: "Home", href: "/" }, { label: 2 }],
            footer: {
              text: "Footer text",
              navLinks: [{ label: "Shop", href: "/shop" }, { href: "/bad" }],
            },
            showWalletPage: "yes",
          },
        }),
      })
    ).toEqual(
      expect.objectContaining({
        content: expect.objectContaining({
          storefront: {
            shopSlug: "fresh-farm",
            productLayout: "grid",
            navLinks: [{ label: "Home", href: "/" }],
            footer: {
              text: "Footer text",
              navLinks: [{ label: "Shop", href: "/shop" }],
            },
          },
        }),
      })
    );
  });

  test("preserves contact_form sections and their fields through normalization", () => {
    const result = parseSellerShopProfileEvent({
      id: "shop-event",
      pubkey: "seller-pubkey",
      created_at: 1710000000,
      kind: 30019,
      sig: "sig",
      tags: [["d", "seller-pubkey"]],
      content: JSON.stringify({
        name: "Fresh Farm",
        storefront: {
          shopSlug: "fresh-farm",
          sections: [
            {
              id: "cf-home",
              type: "contact_form",
              enabled: true,
              heading: "Get in touch",
              body: "We'd love to hear from you.",
              ctaText: "Send it",
              successMessage: "Thanks for reaching out!",
              headingColor: "#123456",
            },
          ],
          pages: [
            {
              id: "page-contact",
              title: "Contact",
              slug: "contact",
              sections: [
                {
                  id: "cf-page",
                  type: "contact_form",
                  enabled: true,
                  heading: "Reach us",
                  body: "Drop us a line.",
                  ctaText: "Submit",
                  successMessage: "Got it!",
                  headingColor: "#abcdef",
                },
              ],
            },
          ],
        },
      }),
    });

    expect(result).not.toBeNull();
    const storefront = (result as { content: { storefront: any } }).content
      .storefront;

    expect(storefront.sections[0]).toEqual({
      id: "cf-home",
      type: "contact_form",
      enabled: true,
      heading: "Get in touch",
      body: "We'd love to hear from you.",
      ctaText: "Send it",
      successMessage: "Thanks for reaching out!",
      headingColor: "#123456",
    });

    expect(storefront.pages[0].sections[0]).toEqual({
      id: "cf-page",
      type: "contact_form",
      enabled: true,
      heading: "Reach us",
      body: "Drop us a line.",
      ctaText: "Submit",
      successMessage: "Got it!",
      headingColor: "#abcdef",
    });
  });

  test("preserves blog page toggle, blog page sections, and blog post mode", () => {
    const result = parseSellerShopProfileEvent({
      id: "shop-event",
      pubkey: "seller-pubkey",
      created_at: 1710000000,
      kind: 30019,
      sig: "sig",
      tags: [["d", "seller-pubkey"]],
      content: JSON.stringify({
        name: "Fresh Farm",
        storefront: {
          shopSlug: "fresh-farm",
          showBlogPage: true,
          // Invalid blog mode on a homepage section must be dropped.
          sections: [
            {
              id: "blog-home",
              type: "blog",
              enabled: true,
              blogPostMode: "bogus",
            },
          ],
          blogPage: {
            sections: [
              {
                id: "blog-idx",
                type: "blog",
                enabled: true,
                heading: "Our Journal",
                blogLayout: "grid",
                blogPostMode: "selected",
                blogPostLimit: 3,
                blogPostIds: ["post-a", "post-b", 99],
              },
            ],
          },
        },
      }),
    });

    expect(result).not.toBeNull();
    const storefront = (result as { content: { storefront: any } }).content
      .storefront;

    expect(storefront.showBlogPage).toBe(true);

    // Homepage blog section keeps valid fields; invalid mode is stripped.
    expect(storefront.sections[0]).toEqual({
      id: "blog-home",
      type: "blog",
      enabled: true,
    });

    // Blog index page sections keep the full blog field set; non-string ids
    // are filtered out of blogPostIds.
    expect(storefront.blogPage.sections[0]).toEqual({
      id: "blog-idx",
      type: "blog",
      enabled: true,
      heading: "Our Journal",
      blogLayout: "grid",
      blogPostMode: "selected",
      blogPostLimit: 3,
      blogPostIds: ["post-a", "post-b"],
    });
  });

  test("selects seller listing summaries from cached product events", () => {
    const summaries = selectSellerListingSummaries(
      [
        {
          id: "seller-listing",
          pubkey: "seller-pubkey",
          created_at: 1710000000,
          kind: 30402,
          content: "",
          tags: [
            ["title", "Creamline Milk"],
            ["status", "active"],
            ["price", "12.5", "USD"],
            ["t", "Milk"],
            ["t", "FREEMILK"],
            ["t", "Local"],
            ["d", "listing-1"],
          ],
        },
        {
          id: "other-listing",
          pubkey: "other-pubkey",
          created_at: 1711000000,
          kind: 30402,
          content: "",
          tags: [["title", "Ignore Me"]],
        },
      ],
      "seller-pubkey"
    );

    expect(summaries).toEqual([
      {
        id: "seller-listing",
        pubkey: "seller-pubkey",
        createdAt: 1710000000,
        title: "Creamline Milk",
        status: "active",
        price: 12.5,
        currency: "USD",
        categories: ["Milk", "Local"],
        primaryCategory: "Milk",
        dTag: "listing-1",
      },
    ]);
  });
});
