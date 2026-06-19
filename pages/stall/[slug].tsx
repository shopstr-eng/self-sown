import { useCallback, useContext } from "react";
import { useRouter } from "next/router";
import { ShopMapContext } from "@/utils/context/context";
import StorefrontLayout from "@/components/storefront/storefront-layout";
import StorefrontLoadError from "@/components/storefront/storefront-load-error";
import MilkMarketSpinner from "@/components/utility-components/mm-spinner";
import { useStorefrontLookup } from "@/utils/storefront/use-storefront-lookup";
import { matchShopSlug } from "@/utils/storefront/match-shop-slug";
import { GetServerSideProps } from "next";
import { OgMetaProps, DEFAULT_OG } from "@/components/og-head";
import {
  fetchShopPubkeyBySlug,
  fetchShopProfileByPubkeyFromDb,
  fetchProfileByPubkeyFromDb,
  fetchProductByDTagAndPubkey,
  fetchProductsByPubkeyFromDb,
} from "@/utils/db/db-service";
import {
  resolveStallBranding,
  buildStallOgMeta,
} from "@/utils/storefront/stall-branding";
import { getMembershipView } from "@/utils/pro/membership";
import { eventToProductOgMeta } from "@/utils/og/product-og";
import { buildUcpCatalog } from "@/utils/ucp/catalog";
import { buildItemListJsonLd } from "@/utils/geo/product-jsonld";

type ShopPageProps = {
  ogMeta: OgMetaProps;
  shopPubkey: string;
  ssrShopName: string;
  ssrShopAbout: string;
};

export const getServerSideProps: GetServerSideProps<ShopPageProps> = async (
  context
) => {
  const { slug } = context.query;
  const shopSlug = typeof slug === "string" ? slug : "";

  // Resolve the origin + canonical path this stall page actually settles on so
  // structured-data links match the page's canonical link tag. When the request
  // arrives via a seller custom domain the proxy forwards the original host +
  // public path (e.g. "https://farmer.com/"); otherwise it's the platform stall
  // URL. Mirrors the canonical logic in DynamicHead.
  const rawHost = context.req.headers["x-mm-custom-domain-host"];
  const customHost = (typeof rawHost === "string" ? rawHost : "")
    .toLowerCase()
    .trim()
    .replace(/:\d+$/, "");
  const rawOriginalPath = context.req.headers["x-mm-original-path"];
  const originalPath =
    typeof rawOriginalPath === "string" ? rawOriginalPath : "";
  const stallOrigin = customHost
    ? `https://${customHost}`
    : "https://milk.market";
  const stallPath = customHost ? originalPath || "/" : `/stall/${shopSlug}`;
  const canonicalStallUrl = `${stallOrigin}${stallPath === "/" ? "" : stallPath}`;

  if (!shopSlug) {
    return {
      props: {
        ogMeta: DEFAULT_OG,
        shopPubkey: "",
        ssrShopName: "",
        ssrShopAbout: "",
      },
    };
  }

  try {
    const pubkey = await fetchShopPubkeyBySlug(shopSlug);
    if (pubkey) {
      // Custom storefront branding is a Pro feature, so only entitled sellers
      // (active/trialing/grace) serve their custom OG meta. Lapsed sellers
      // (read-only/hidden) fall back to the default meta — crawlers/social bots
      // never see premium title/description/image without an active membership.
      const membership = await getMembershipView(pubkey);
      const [shopEvent, profileEvent] = await Promise.all([
        fetchShopProfileByPubkeyFromDb(pubkey),
        fetchProfileByPubkeyFromDb(pubkey),
      ]);

      // Always extract shop name/about for SSR content (crawlers + bots)
      let ssrShopName = "";
      let ssrShopAbout = "";
      if (shopEvent) {
        try {
          const c = JSON.parse(shopEvent.content);
          ssrShopName = c.name || "";
          ssrShopAbout = c.about || "";
        } catch {}
      }
      if (!ssrShopName && profileEvent) {
        try {
          const c = JSON.parse(profileEvent.content);
          ssrShopName = c.display_name || c.name || "";
        } catch {}
      }

      if (shopEvent && membership.isPro) {
        const content = JSON.parse(shopEvent.content);
        let profileContent: Record<string, unknown> | null = null;
        if (profileEvent) {
          try {
            profileContent = JSON.parse(profileEvent.content);
          } catch {
            profileContent = null;
          }
        }

        // When this Pro seller serves a single product at their storefront
        // root, emit that product's OG meta so social/crawler previews show
        // the product (not the generic stall). The URL stays at the stall root.
        const sf = content?.storefront;
        if (
          sf?.landingPageMode === "product" &&
          typeof sf?.landingProductDTag === "string" &&
          sf.landingProductDTag
        ) {
          try {
            const productEvent = await fetchProductByDTagAndPubkey(
              sf.landingProductDTag,
              pubkey
            );
            if (productEvent) {
              return {
                props: {
                  // The product is served AT the stall root, so its canonical
                  // (and thus JSON-LD) URL is the stall URL, not /listing/...
                  ogMeta: eventToProductOgMeta(
                    productEvent,
                    `/stall/${shopSlug}`,
                    canonicalStallUrl
                  ),
                  shopPubkey: pubkey,
                  ssrShopName,
                  ssrShopAbout,
                },
              };
            }
          } catch (err) {
            console.error("SSR product OG fetch error for stall root:", err);
          }
        }

        const branding = resolveStallBranding(content, profileContent);
        const title = branding.seo?.metaTitle
          ? branding.seo.metaTitle
          : `${branding.shopName}: Farm-Fresh Products | Milk Market`;

        // schema.org ItemList of the storefront's products so crawlers + AI
        // shopping agents can discover the stall's catalog from the SSR HTML.
        // Bounded fetch (no full feed); failure never breaks the stall OG meta.
        let jsonLd: Record<string, unknown>[] | undefined;
        try {
          const productEvents = await fetchProductsByPubkeyFromDb(pubkey, 50);
          if (productEvents.length > 0) {
            // On a custom domain the catalog's product links must stay on the
            // seller's own origin (where /listing/... is served) so each item
            // URL matches the canonical product page.
            const products = buildUcpCatalog(
              productEvents,
              customHost ? { sellerOrigin: stallOrigin } : {}
            );
            jsonLd = [
              buildItemListJsonLd(products, {
                url: canonicalStallUrl,
                name: title,
              }),
            ];
          }
        } catch (err) {
          console.error("SSR ItemList build error for stall:", err);
        }

        return {
          props: {
            ogMeta: {
              ...buildStallOgMeta({
                branding,
                title,
                url: `/stall/${shopSlug}`,
                keywordSeed: shopSlug,
              }),
              ...(jsonLd ? { jsonLd } : {}),
            },
            shopPubkey: pubkey,
            ssrShopName: branding.shopName || ssrShopName,
            ssrShopAbout: branding.about || ssrShopAbout,
          },
        };
      }
      return {
        props: {
          ogMeta: {
            ...DEFAULT_OG,
            title: "Milk Market Stall",
            description: "Check out this shop on Milk Market!",
            url: `/stall/${shopSlug}`,
          },
          shopPubkey: pubkey,
          ssrShopName,
          ssrShopAbout,
        },
      };
    }
  } catch (error) {
    console.error("SSR OG fetch error for shop:", error);
  }

  return {
    props: {
      ogMeta: {
        ...DEFAULT_OG,
        title: "Milk Market Stall",
        description: "Check out this shop on Milk Market!",
        url: `/stall/${shopSlug}`,
      },
      shopPubkey: "",
      ssrShopName: "",
      ssrShopAbout: "",
    },
  };
};

export default function ShopPage({
  shopPubkey: ssrShopPubkey,
  ssrShopName,
  ssrShopAbout,
}: ShopPageProps) {
  const router = useRouter();
  const { slug } = router.query;
  const slugStr = typeof slug === "string" ? slug : "";
  const shopMapContext = useContext(ShopMapContext);

  const resolveLocal = useCallback(
    () => matchShopSlug(shopMapContext.shopData, slugStr),
    [shopMapContext.shopData, slugStr]
  );

  const { state, retry } = useStorefrontLookup({
    kind: "slug",
    value: slugStr,
    ssrPubkey: ssrShopPubkey,
    resolveLocal,
    localPending: shopMapContext.isLoading,
    ready: router.isReady,
  });

  if (state.phase === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center pt-20">
        <MilkMarketSpinner />
      </div>
    );
  }

  if (state.phase === "error") {
    return <StorefrontLoadError onRetry={retry} label="stall" />;
  }

  if (state.phase === "not_found") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center pt-20">
        <h1 className="text-3xl font-bold">Stall Not Found</h1>
        <p className="mt-4 text-gray-500">
          This shop doesn&apos;t exist or hasn&apos;t been set up yet.
        </p>
        <a
          href="/marketplace"
          className="bg-primary-blue mt-6 rounded-lg px-6 py-3 font-bold text-white transition-transform hover:-translate-y-0.5"
        >
          Browse Marketplace
        </a>
      </div>
    );
  }

  return (
    <StorefrontLayout
      shopPubkey={state.pubkey}
      ssrShopName={ssrShopName}
      ssrShopAbout={ssrShopAbout}
    />
  );
}
