import { sanitizeStorefrontConfigLinks } from "@/utils/storefront-links";
import type { StorefrontConfig } from "@/utils/types/types";

describe("sanitizeStorefrontConfigLinks section buttons", () => {
  test("blocks javascript: button hrefs and keeps safe ones everywhere sections live", () => {
    const buttons = [
      { label: "Safe", href: "https://example.com/shop" },
      { label: "Evil", href: "javascript:alert(1)" },
      { label: "Anchor", href: "#products" },
      { label: "NoHref" },
    ];
    const config: StorefrontConfig = {
      shopSlug: "farm",
      sections: [{ id: "s1", type: "text", buttons }],
      pages: [
        {
          id: "p1",
          title: "Story",
          slug: "story",
          sections: [{ id: "s2", type: "text", buttons }],
        },
      ],
      blogPage: { sections: [{ id: "s3", type: "text", buttons }] },
    };

    const out = sanitizeStorefrontConfigLinks(config);
    for (const section of [
      out.sections![0]!,
      out.pages![0]!.sections[0]!,
      out.blogPage!.sections[0]!,
    ]) {
      expect(section.buttons).toEqual([
        { label: "Safe", href: "https://example.com/shop" },
        { label: "Evil", href: "#products" },
        { label: "Anchor", href: "#products" },
        { label: "NoHref" },
      ]);
    }
  });
});
