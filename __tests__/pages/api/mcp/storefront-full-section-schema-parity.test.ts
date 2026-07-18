/**
 * Guards against drift between the MCP write-tool zod schema
 * (storefrontSectionSchema in mcp/tools/write-tools.ts) and the domain
 * FULL section sanitizer (sanitizeFullSection in packages/domain/src/seller.ts)
 * used for the homepage `sections[]` and `blogPage.sections[]`.
 *
 * Zod strips unknown keys at the tool boundary, so a field the sanitizer
 * would keep but the schema doesn't know about is silently dropped when a
 * seller saves through set_shop_profile — the homepage loses its look with
 * no error anywhere. This is the same failure mode the sibling
 * storefront-section-schema-parity test guards for the reduced pages[]
 * sanitizer.
 */

// write-tools.ts pulls in the whole MCP surface at module scope; stub the
// heavy transitive imports (DB, signing, email) — the schema itself is a
// plain zod object with no dependencies on any of these.
jest.mock("@/utils/db/db-service", () => ({}));
jest.mock("@/utils/db/inventory-service", () => ({ setStock: jest.fn() }));
jest.mock("@/utils/mcp/auth", () => ({ getAgentSigner: jest.fn() }));
jest.mock("@/utils/mcp/nostr-signing", () => ({}));
jest.mock("@/utils/mcp/request-proof", () => ({}));
jest.mock("@/utils/nostr/request-auth", () => ({}));
jest.mock("@/utils/lightning/direct-lnurl", () => ({
  derivePaymentPreference: jest.fn(),
}));
jest.mock("@/utils/email/flow-email-templates", () => ({
  getDefaultFlowSteps: jest.fn(),
}));
jest.mock("@/mcp/tools/order-status-auth", () => ({}));
jest.mock("@/mcp/tools/register-tool", () => ({ registerTool: jest.fn() }));
jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {},
}));
jest.mock("@milk-market/nostr", () => ({
  createSellerActionAuthEventTemplate: jest.fn(),
}));

import { storefrontSectionSchema } from "@/mcp/tools/write-tools";
import { parseSellerShopProfileEvent } from "@milk-market/domain";

// Every field the full homepage sections[] sanitizer keeps, fully populated
// with values that are valid in both the sanitizer and the zod schema.
const FULL_HOME_SECTION = {
  id: "sec-1",
  type: "hero",
  enabled: true,
  heading: "Welcome to the farm",
  subheading: "Fresh raw milk daily",
  body: "Family-owned since 1985.",
  image: "https://example.com/hero.jpg",
  imagePosition: "left",
  fullWidth: true,
  ctaText: "Shop now",
  ctaLink: "/products",
  overlayOpacity: 0.5,
  headingColor: "#abcdef",
  subheadingColor: "#123456",
  textOutlineColor: "#000000",
  items: [{ question: "Is it raw?", answer: "Yes." }],
  testimonials: [
    {
      quote: "Best milk ever",
      author: "Jane",
      image: "https://example.com/jane.jpg",
      rating: 5,
    },
  ],
  ingredientItems: [
    {
      name: "Milk",
      description: "Whole raw milk",
      image: "https://example.com/milk.jpg",
    },
  ],
  comparisonFeatures: ["Freshness"],
  comparisonColumns: [{ heading: "Ours", values: ["Same-day"] }],
  timelineItems: [
    {
      year: "1985",
      heading: "Founded",
      body: "The farm began.",
      image: "https://example.com/farm.jpg",
    },
  ],
  productLayout: "featured",
  productLimit: 6,
  email: "farm@example.com",
  phone: "555-0100",
  address: "1 Farm Rd",
  successMessage: "Got it!",
  contactFormMode: "subscription",
  showNameField: true,
  showPhoneField: false,
  showMessageField: true,
  caption: "Our herd at pasture",
  blogLayout: "featured",
  blogPostIds: ["post-1", "post-2"],
  blogPostLimit: 4,
  blogPostMode: "selected",
  bannerSlides: [
    {
      image: "https://example.com/slide.jpg",
      heading: "Slide heading",
      subheading: "Slide subheading",
      ctaText: "Learn more",
      ctaLink: "/about",
    },
  ],
  bannerAutoplay: true,
  bannerInterval: 5000,
  socialPosts: [
    {
      platform: "instagram",
      url: "https://instagram.com/p/abc",
      caption: "Morning milking",
      image: "https://example.com/post.jpg",
      author: "@farm",
    },
  ],
  socialPostsLayout: "carousel",
  socialPostsAutoplay: true,
  socialPostsSpeed: 4000,
  marqueeBackgroundColor: "#ff0000",
  marqueeSpeed: 25,
  marqueeDirection: "right",
  backgroundColor: "#112233",
  textColor: "#445566",
  textAlign: "center",
  contentWidth: "narrow",
  imageHeight: "tall",
  imageFit: "contain",
  elementOrder: ["heading", "subheading", "body", "image", "buttons"],
  imagePlacement: "background",
  headingSize: "xl",
  bodySize: "sm",
  imageWidth: 66,
  buttons: [
    {
      label: "Shop now",
      href: "/products",
      variant: "outline",
      size: "lg",
      align: "right",
    },
  ],
} as const;

function sanitizeHomeSection(section: Record<string, unknown>) {
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
        sections: [section],
      },
    }),
  });
  expect(result).not.toBeNull();
  const storefront = (result as { content: { storefront: any } }).content
    .storefront;
  return storefront.sections[0] as Record<string, unknown>;
}

describe("MCP storefrontSectionSchema vs domain full sections[] sanitizer", () => {
  test("fixture covers every field the full sanitizer keeps", () => {
    // If a field in the fixture is invalid/unknown to the sanitizer, or the
    // fixture is missing a sanitizer field, this fails and the fixture must
    // be updated — keeping the parity assertions below meaningful.
    expect(sanitizeHomeSection({ ...FULL_HOME_SECTION })).toEqual(
      FULL_HOME_SECTION
    );
  });

  test("zod schema keeps every field the sanitizer keeps (nothing stripped at the tool boundary)", () => {
    const parsed = storefrontSectionSchema.parse({ ...FULL_HOME_SECTION });
    expect(parsed).toEqual(FULL_HOME_SECTION);
  });

  test("every field the sanitizer inspects exists in the zod schema", () => {
    // Wrap the section in a recording Proxy (injected via JSON.parse so it
    // survives parseSellerShopProfileEvent's content parsing) to capture the
    // exact set of keys the sanitizer reads. This fails when a field is added
    // to sanitizeFullSection (or sanitizeSectionLayoutFields) without
    // updating the zod schema, even if the fixture above hasn't been updated.
    const accessedKeys = new Set<string>();
    const recordingProxy = new Proxy(
      { ...FULL_HOME_SECTION } as Record<string, unknown>,
      {
        get(target, prop, receiver) {
          if (typeof prop === "string") accessedKeys.add(prop);
          return Reflect.get(target, prop, receiver);
        },
      }
    );

    const realParse = JSON.parse.bind(JSON);
    const parseSpy = jest
      .spyOn(JSON, "parse")
      .mockImplementation((text: string, reviver?: any) => {
        const value = realParse(text, reviver);
        const sections = value?.storefront?.sections;
        if (Array.isArray(sections)) sections[0] = recordingProxy;
        return value;
      });
    try {
      sanitizeHomeSection({ ...FULL_HOME_SECTION });
    } finally {
      parseSpy.mockRestore();
    }

    expect(accessedKeys.size).toBeGreaterThan(0);
    const schemaKeys = new Set(Object.keys(storefrontSectionSchema.shape));
    const missingFromSchema = [...accessedKeys].filter(
      (key) => !schemaKeys.has(key)
    );
    expect(missingFromSchema).toEqual([]);
  });
});
