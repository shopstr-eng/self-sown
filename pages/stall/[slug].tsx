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
} from "@/utils/db/db-service";
import {
  resolveStallBranding,
  buildStallOgMeta,
} from "@/utils/storefront/stall-branding";
import { getMembershipView } from "@/utils/pro/membership";
import { eventToProductOgMeta } from "@/utils/og/product-og";

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
                  ogMeta: eventToProductOgMeta(
                    productEvent,
                    `/stall/${shopSlug}`
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
          : `${branding.shopName} — Farm-Fresh Products | Milk Market`;

        return {
          props: {
            ogMeta: buildStallOgMeta({
              branding,
              title,
              url: `/stall/${shopSlug}`,
              keywordSeed: shopSlug,
            }),
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
