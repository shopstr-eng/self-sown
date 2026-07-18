import {
  buildSellerShopProfileContent,
  normalizeStorefrontSlug,
  orderedPaymentMethodGroups,
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

  test("preserves productPageDefaults (including product-scoped types) when parsing", () => {
    const parsed = parseSellerShopProfileEvent({
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
          productPageDefaults: [
            { id: "s1", type: "product_gallery", enabled: true },
            { id: "s2", type: "marquee", heading: "Fresh raw milk" },
            {
              id: "s3",
              type: "contact_form",
              enabled: true,
              contactFormMode: "subscription",
            },
            "not-a-section",
          ],
        },
      }),
    });
    expect(parsed?.content.storefront?.productPageDefaults).toEqual([
      { id: "s1", type: "product_gallery", enabled: true },
      { id: "s2", type: "marquee", heading: "Fresh raw milk" },
      {
        id: "s3",
        type: "contact_form",
        enabled: true,
        contactFormMode: "subscription",
      },
    ]);
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

  test("preserves blog section settings on custom page-builder pages", () => {
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
          pages: [
            {
              id: "page-news",
              title: "News",
              slug: "news",
              sections: [
                {
                  id: "blog-page",
                  type: "blog",
                  enabled: true,
                  heading: "Farm News",
                  blogLayout: "list",
                  blogPostMode: "selected",
                  blogPostLimit: 5,
                  blogPostIds: ["post-a", "post-b", 42],
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

    // Custom-page sections must keep the full blog field set, matching the
    // homepage sanitizer; non-string ids are filtered out of blogPostIds.
    expect(storefront.pages[0].sections[0]).toEqual({
      id: "blog-page",
      type: "blog",
      enabled: true,
      heading: "Farm News",
      blogLayout: "list",
      blogPostMode: "selected",
      blogPostLimit: 5,
      blogPostIds: ["post-a", "post-b"],
    });
  });

  test("preserves banner_carousel sections and drops slides without an image", () => {
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
              id: "banner-home",
              type: "banner_carousel",
              enabled: true,
              fullWidth: true,
              bannerAutoplay: true,
              bannerInterval: 6000,
              overlayOpacity: 0.5,
              headingColor: "#ffffff",
              subheadingColor: "#eeeeee",
              textOutlineColor: "#000000",
              bannerSlides: [
                {
                  image: "https://cdn.example.com/1.jpg",
                  heading: "Slide 1",
                  subheading: "Sub 1",
                  ctaText: "Shop",
                  ctaLink: "#products",
                },
                { heading: "No image slide" },
                { image: "https://cdn.example.com/2.jpg" },
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
      id: "banner-home",
      type: "banner_carousel",
      enabled: true,
      fullWidth: true,
      bannerAutoplay: true,
      bannerInterval: 6000,
      overlayOpacity: 0.5,
      headingColor: "#ffffff",
      subheadingColor: "#eeeeee",
      textOutlineColor: "#000000",
      bannerSlides: [
        {
          image: "https://cdn.example.com/1.jpg",
          heading: "Slide 1",
          subheading: "Sub 1",
          ctaText: "Shop",
          ctaLink: "#products",
        },
        { image: "https://cdn.example.com/2.jpg" },
      ],
    });
  });

  test("preserves marquee sections and drops an invalid scroll direction", () => {
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
              id: "marquee-home",
              type: "marquee",
              enabled: true,
              heading: "Fresh milk daily",
              image: "https://cdn.example.com/logo.png",
              headingColor: "#ffffff",
              marqueeBackgroundColor: "#111111",
              marqueeSpeed: 25,
              marqueeDirection: "right",
            },
            {
              id: "marquee-bad-dir",
              type: "marquee",
              enabled: true,
              heading: "Brand",
              marqueeDirection: "diagonal",
            },
          ],
        },
      }),
    });

    expect(result).not.toBeNull();
    const storefront = (result as { content: { storefront: any } }).content
      .storefront;

    expect(storefront.sections[0]).toEqual({
      id: "marquee-home",
      type: "marquee",
      enabled: true,
      heading: "Fresh milk daily",
      image: "https://cdn.example.com/logo.png",
      headingColor: "#ffffff",
      marqueeBackgroundColor: "#111111",
      marqueeSpeed: 25,
      marqueeDirection: "right",
    });

    // An unrecognized direction is dropped (renderer falls back to "left").
    expect(storefront.sections[1]).toEqual({
      id: "marquee-bad-dir",
      type: "marquee",
      enabled: true,
      heading: "Brand",
    });
  });

  test("preserves social_posts sections, coercing bad platforms and dropping url-less posts", () => {
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
              id: "videos-home",
              type: "social_posts",
              enabled: true,
              socialPostsLayout: "grid",
              socialPostsAutoplay: false,
              socialPostsSpeed: 4000,
              socialPosts: [
                {
                  platform: "youtube",
                  url: "https://www.youtube.com/watch?v=abc123def",
                  caption: "Farm tour",
                },
                { platform: "myspace", url: "https://example.com/post" },
                { platform: "x" },
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
      id: "videos-home",
      type: "social_posts",
      enabled: true,
      socialPostsLayout: "grid",
      socialPostsAutoplay: false,
      socialPostsSpeed: 4000,
      socialPosts: [
        {
          platform: "youtube",
          url: "https://www.youtube.com/watch?v=abc123def",
          caption: "Farm tour",
        },
        { platform: "other", url: "https://example.com/post" },
      ],
    });
  });

  test("preserves footer newsletter and layout, dropping invalid layout values", () => {
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
          footer: {
            text: "Thanks for visiting",
            newsletter: {
              enabled: true,
              headline: "Stay in the loop",
              subtext: "Get farm updates",
              buttonText: "Subscribe",
              placeholder: "you@example.com",
              successMessage: "You're in!",
              collectPhone: true,
            },
            layout: {
              alignment: "center",
              linkSpacing: "spacious",
              columnLayout: "bogus",
            },
          },
        },
      }),
    });

    expect(result).not.toBeNull();
    const storefront = (result as { content: { storefront: any } }).content
      .storefront;

    expect(storefront.footer.newsletter).toEqual({
      enabled: true,
      headline: "Stay in the loop",
      subtext: "Get farm updates",
      buttonText: "Subscribe",
      placeholder: "you@example.com",
      successMessage: "You're in!",
      collectPhone: true,
    });

    // Invalid columnLayout is stripped; valid alignment/linkSpacing survive.
    expect(storefront.footer.layout).toEqual({
      alignment: "center",
      linkSpacing: "spacious",
    });
  });

  test("orderedPaymentMethodGroups fills, dedupes, and drops invalid groups", () => {
    // No preference → default order.
    expect(orderedPaymentMethodGroups()).toEqual(["bitcoin", "card", "fiat"]);
    expect(orderedPaymentMethodGroups([])).toEqual(["bitcoin", "card", "fiat"]);
    // Custom order is honored, missing groups are appended in default order.
    expect(orderedPaymentMethodGroups(["fiat"])).toEqual([
      "fiat",
      "bitcoin",
      "card",
    ]);
    // Duplicates and unknown groups are dropped.
    expect(
      orderedPaymentMethodGroups(["card", "card", "bogus" as never, "bitcoin"])
    ).toEqual(["card", "bitcoin", "fiat"]);
  });

  test("normalizes storefront paymentMethodOrder and acceptBitcoin", () => {
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
          paymentMethodOrder: ["fiat", "fiat", "bogus", "card"],
          acceptBitcoin: false,
        },
      }),
    });

    const storefront = (result as { content: { storefront: any } }).content
      .storefront;
    // Invalid/duplicate groups filtered; explicit opt-out preserved.
    expect(storefront.paymentMethodOrder).toEqual(["fiat", "card"]);
    expect(storefront.acceptBitcoin).toBe(false);
  });

  test("navLayout transparent/hideOnScroll persist only literal true", () => {
    const parse = (navLayout: unknown) => {
      const result = parseSellerShopProfileEvent({
        id: "shop-event",
        pubkey: "seller-pubkey",
        created_at: 1710000000,
        kind: 30019,
        sig: "sig",
        tags: [["d", "seller-pubkey"]],
        content: JSON.stringify({
          name: "Fresh Farm",
          storefront: { shopSlug: "fresh-farm", navLayout },
        }),
      });
      return (result as { content: { storefront: any } }).content.storefront
        .navLayout;
    };

    // Literal true is kept.
    expect(parse({ transparent: true, hideOnScroll: true })).toEqual({
      transparent: true,
      hideOnScroll: true,
    });
    // false / truthy junk are dropped so existing events stay byte-stable.
    expect(
      parse({ transparent: false, hideOnScroll: "yes", logoPosition: "center" })
    ).toEqual({ logoPosition: "center" });
  });

  test("keeps acceptBitcoin absent when Bitcoin is accepted (byte-stable default)", () => {
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
          acceptBitcoin: true,
        },
      }),
    });

    const storefront = (result as { content: { storefront: any } }).content
      .storefront;
    expect(storefront).not.toHaveProperty("acceptBitcoin");
    expect(storefront).not.toHaveProperty("paymentMethodOrder");
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
