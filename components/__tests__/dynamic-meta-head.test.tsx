import React from "react";
import { render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import DynamicHead from "../dynamic-meta-head";
import { useRouter } from "next/router";
import { nip19 } from "nostr-tools";
import parseTags from "@/utils/parsers/product-parser-functions";
import { NostrEvent, ShopProfile } from "@/utils/types/types";
import { SITE_URL } from "@/utils/site-url";

jest.mock("next/head", () => {
  return {
    __esModule: true,
    default: ({ children }: { children: Array<React.ReactElement> }) => {
      return <>{children}</>;
    },
  };
});

jest.mock("next/router", () => ({
  useRouter: jest.fn(),
}));
const mockUseRouter = useRouter as jest.Mock;

jest.mock("nostr-tools", () => ({
  nip19: {
    naddrEncode: jest.fn(),
    npubEncode: jest.fn(),
    decode: jest.fn(),
  },
}));
const mockNip19 = nip19 as jest.Mocked<typeof nip19>;

jest.mock("@/utils/parsers/product-parser-functions", () => ({
  __esModule: true,
  default: jest.fn(),
}));
const mockParseTags = parseTags as jest.Mock;

describe("DynamicHead", () => {
  const getMetaContent = (name: string) => {
    const element = document.querySelector(
      `meta[name="${name}"], meta[property="${name}"]`
    );
    return element?.getAttribute("content");
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("should render default meta tags for a generic page", async () => {
    mockUseRouter.mockReturnValue({ pathname: "/", asPath: "/", query: {} });
    render(
      <DynamicHead
        productEvents={[]}
        shopEvents={new Map()}
        profileData={new Map()}
      />
    );
    await waitFor(() => {
      expect(document.title).toBe(
        "Self-sown - Sell Local Products Online. Zero Platform Fees."
      );
    });
  });

  describe("Shop Pages", () => {
    test("should render meta tags for a specific shop page when shop is found", async () => {
      const shopPubkey = "shop_pubkey_1";
      const shopNpub = "npub1shop";
      const shopEvents = new Map<string, ShopProfile>([
        [
          shopPubkey,
          {
            pubkey: shopPubkey,
            content: {
              name: "Nostr Goods",
              about: "The best goods on Nostr.",
              ui: {
                picture: "https://shop.com/logo.png",
                banner: "",
                theme: "",
                darkMode: false,
              },
              merchants: [],
            },
            created_at: 0,
          } as ShopProfile,
        ],
      ]);
      mockUseRouter.mockReturnValue({
        pathname: `/marketplace/${shopNpub}`,
        asPath: `/marketplace/${shopNpub}`,
        query: { npub: [shopNpub] },
      });
      mockNip19.npubEncode.mockReturnValue(shopNpub);
      render(
        <DynamicHead
          productEvents={[]}
          shopEvents={shopEvents}
          profileData={new Map()}
        />
      );
      await waitFor(() => expect(document.title).toBe("Nostr Goods Stall"));
    });

    test("should render fallback meta tags for a shop page when shop is not found", async () => {
      const shopNpub = "npub1shop_not_found";
      mockUseRouter.mockReturnValue({
        pathname: `/marketplace/${shopNpub}`,
        asPath: `/marketplace/${shopNpub}`,
        query: { npub: [shopNpub] },
      });
      render(
        <DynamicHead
          productEvents={[]}
          shopEvents={new Map()}
          profileData={new Map()}
        />
      );
      await waitFor(() => expect(document.title).toBe("Self-sown Stall"));
    });

    test("should render fallback tags if npub is missing from query", async () => {
      mockUseRouter.mockReturnValue({
        pathname: `/marketplace/npub`,
        asPath: `/marketplace/npub`,
        query: {},
      });
      render(
        <DynamicHead
          productEvents={[]}
          shopEvents={new Map()}
          profileData={new Map()}
        />
      );
      await waitFor(() =>
        expect(document.title).toBe(
          "Self-sown - Sell Local Products Online. Zero Platform Fees."
        )
      );
      expect(getMetaContent("og:url")).toBe(`${SITE_URL}/marketplace/npub`);
    });

    test("should use fallback image for a shop with picture set to null", async () => {
      const shopPubkey = "shop_pubkey_3";
      const shopNpub = "npub1nullpic";
      const shopEvents = new Map<string, ShopProfile>([
        [
          shopPubkey,
          {
            pubkey: shopPubkey,
            content: {
              name: "Test Shop",
              about: "",
              ui: { picture: "", banner: "", theme: "", darkMode: false },
              merchants: [],
            },
            created_at: 0,
          } as ShopProfile,
        ],
      ]);
      mockUseRouter.mockReturnValue({
        pathname: `/marketplace/${shopNpub}`,
        asPath: `/marketplace/${shopNpub}`,
        query: { npub: [shopNpub] },
      });
      mockNip19.npubEncode.mockReturnValue(shopNpub);
      render(
        <DynamicHead
          productEvents={[]}
          shopEvents={shopEvents}
          profileData={new Map()}
        />
      );
      await waitFor(() =>
        expect(getMetaContent("og:image")).toBe(
          `${SITE_URL}/api/og-image?url=${encodeURIComponent(
            `${SITE_URL}/self-sown-black.png`
          )}`
        )
      );
    });
  });

  describe("Listing Pages", () => {
    const productId = "product_123";
    const productPubkey = "product_pubkey_1";
    const productEvent = {
      id: productId,
      pubkey: productPubkey,
      tags: [["d", "some_other_id"]],
      kind: 30402,
    } as NostrEvent;

    test("should find a product by event id if d tag does not match", async () => {
      const naddr = "naddr1product";
      mockUseRouter.mockReturnValue({
        pathname: `/listing/${productId}`,
        asPath: `/listing/${productId}`,
        query: { productId: [productId] },
      });
      mockNip19.naddrEncode.mockReturnValue(naddr);
      mockParseTags.mockReturnValue({ title: "Found By ID" });
      render(
        <DynamicHead
          productEvents={[productEvent]}
          shopEvents={new Map()}
          profileData={new Map()}
        />
      );
      await waitFor(() => expect(document.title).toBe("Found By ID"));
    });

    test("should resolve relay-hinted naddr routes from the matching listing identity", async () => {
      // Downstream mocks nostr-tools, so emulate a relay-hinted naddr by
      // having nip19.decode return the listing identity that matches the
      // product event's d tag/pubkey/kind. The component resolves the listing
      // via eventMatchesListingIdentifier, which decodes naddr identifiers.
      const relayHintedNaddr = "naddr1relayhinted";
      mockNip19.naddrEncode.mockReturnValue(relayHintedNaddr);
      mockNip19.decode.mockReturnValue({
        type: "naddr",
        data: {
          identifier: "some_other_id",
          pubkey: productPubkey,
          kind: 30402,
          relays: [
            "wss://relay.shopstr.example",
            "wss://relay-2.shopstr.example",
          ],
        },
      } as ReturnType<typeof nip19.decode>);
      mockUseRouter.mockReturnValue({
        pathname: `/listing/${relayHintedNaddr}`,
        asPath: `/listing/${relayHintedNaddr}`,
        query: { productId: [relayHintedNaddr] },
      });
      mockParseTags.mockReturnValue({ title: "Relay Hint Listing" });
      render(
        <DynamicHead
          productEvents={[productEvent]}
          shopEvents={new Map()}
          profileData={new Map()}
        />
      );
      await waitFor(() => expect(document.title).toBe("Relay Hint Listing"));
    });

    test("should use fallback values for a parsed product with partial data", async () => {
      const naddr = "naddr1product";
      mockUseRouter.mockReturnValue({
        pathname: `/listing/${productId}`,
        asPath: `/listing/${productId}`,
        query: { productId: [productId] },
      });
      mockNip19.naddrEncode.mockReturnValue(naddr);
      mockParseTags.mockReturnValue({ summary: "Only summary exists." });
      render(
        <DynamicHead
          productEvents={[productEvent]}
          shopEvents={new Map()}
          profileData={new Map()}
        />
      );
      await waitFor(() => expect(document.title).toBe("Self-sown Listing"));
      expect(getMetaContent("og:image")).toBe(
        `${SITE_URL}/api/og-image?url=${encodeURIComponent(
          `${SITE_URL}/self-sown-black.png`
        )}`
      );
    });

    test("should render fallback tags for a listing when parsing fails", async () => {
      const naddr = "naddr1product";
      mockUseRouter.mockReturnValue({
        pathname: `/listing/${productId}`,
        asPath: `/listing/${productId}`,
        query: { productId: [productId] },
      });
      mockNip19.naddrEncode.mockReturnValue(naddr);
      mockParseTags.mockReturnValue(null);
      render(
        <DynamicHead
          productEvents={[productEvent]}
          shopEvents={new Map()}
          profileData={new Map()}
        />
      );
      await waitFor(() => expect(document.title).toBe("Self-sown Listing"));
    });
  });

  describe("Storefront canonical + og:url host selection", () => {
    // A seller with a verified custom domain must have their <link
    // rel="canonical"> and og:url/twitter:url point at THEIR domain (not the
    // platform /stall/<slug> URL) when the page is served from that domain;
    // on the platform host the tags keep pointing at /stall/<slug>. The stall
    // pages pass a relative ssrOgMeta.url plus the proxy-forwarded
    // custom-domain host/original path; the split between search/social
    // identity lives entirely in this component.
    const stallOgMeta = {
      title: "Naughty Goat Farm",
      description: "Farm-fresh products",
      image: "/self-sown-black.png",
      // What pages/stall/[slug].tsx passes — the platform path regardless of
      // the host the request arrived on.
      url: "/stall/naughtygoat",
    };

    const getCanonicalHref = () =>
      document
        .querySelector('link[rel="canonical"]')
        ?.getAttribute("href");

    const renderStall = (
      customDomain?: { host: string; originalPath: string }
    ) =>
      render(
        <DynamicHead
          productEvents={[]}
          shopEvents={new Map()}
          profileData={new Map()}
          ssrOgMeta={stallOgMeta}
          isCustomDomain={!!customDomain}
          customDomainHost={customDomain?.host ?? null}
          customDomainOriginalPath={customDomain?.originalPath ?? null}
        />
      );

    test("platform host keeps canonical/og:url on /stall/<slug>", async () => {
      mockUseRouter.mockReturnValue({
        pathname: "/stall/[slug]",
        asPath: "/stall/naughtygoat",
        query: { slug: "naughtygoat" },
      });
      renderStall();
      await waitFor(() => {
        expect(getCanonicalHref()).toBe(
          `${SITE_URL}/stall/naughtygoat`
        );
      });
      expect(getMetaContent("og:url")).toBe(`${SITE_URL}/stall/naughtygoat`);
      expect(getMetaContent("twitter:url")).toBe(
        `${SITE_URL}/stall/naughtygoat`
      );
    });

    test("custom domain root canonicalizes to the seller's domain", async () => {
      mockUseRouter.mockReturnValue({
        pathname: "/stall/[slug]",
        asPath: "/stall/naughtygoat",
        query: { slug: "naughtygoat" },
      });
      renderStall({ host: "NaughtyGoat.farm", originalPath: "/" });
      await waitFor(() => {
        expect(getCanonicalHref()).toBe("https://naughtygoat.farm");
      });
      expect(getMetaContent("og:url")).toBe("https://naughtygoat.farm");
      expect(getMetaContent("twitter:url")).toBe("https://naughtygoat.farm");
    });

    test("custom domain subpage keeps the forwarded original path", async () => {
      mockUseRouter.mockReturnValue({
        pathname: "/stall/[...stallPath]",
        asPath: "/stall/naughtygoat/blog",
        query: { stallPath: ["naughtygoat", "blog"] },
      });
      renderStall({ host: "NaughtyGoat.farm", originalPath: "/blog" });
      await waitFor(() => {
        expect(getCanonicalHref()).toBe("https://naughtygoat.farm/blog");
      });
      expect(getMetaContent("og:url")).toBe("https://naughtygoat.farm/blog");
    });
  });
});
