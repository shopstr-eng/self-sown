import { useCallback, useContext } from "react";
import { useRouter } from "next/router";
import { ShopMapContext } from "@/utils/context/context";
import StorefrontLayout from "@/components/storefront/storefront-layout";
import StorefrontLoadError from "@/components/storefront/storefront-load-error";
import ThemedStallOrders from "@/components/storefront/themed-stall-orders";
import MilkMarketSpinner from "@/components/utility-components/mm-spinner";
import { useStorefrontLookup } from "@/utils/storefront/use-storefront-lookup";
import { matchShopSlug } from "@/utils/storefront/match-shop-slug";
import { GetServerSideProps } from "next";
import { OgMetaProps, DEFAULT_OG } from "@/components/og-head";
import {
  fetchShopPubkeyBySlug,
  fetchShopProfileByPubkeyFromDb,
  fetchProfileByPubkeyFromDb,
} from "@/utils/db/db-service";
import {
  resolveStallBranding,
  buildStallOgMeta,
} from "@/utils/storefront/stall-branding";
import { getMembershipView } from "@/utils/pro/membership";

type ShopSubPageProps = {
  ogMeta: OgMetaProps;
  shopPubkey: string;
  ssrShopName: string;
  ssrShopAbout: string;
};

export const getServerSideProps: GetServerSideProps<ShopSubPageProps> = async (
  context
) => {
  const { stallPath } = context.query;
  const pathParts = Array.isArray(stallPath) ? stallPath : [];
  const slug = pathParts[0] || "";

  if (!slug) {
    return {
      props: {
        ogMeta: DEFAULT_OG,
        shopPubkey: "",
        ssrShopName: "",
        ssrShopAbout: "",
      },
    };
  }

  const subPage = pathParts[1] || "";

  try {
    const pubkey = await fetchShopPubkeyBySlug(slug);
    if (pubkey) {
      // Custom storefront branding is a Pro feature, so only entitled sellers
      // (active/trialing/grace) serve their custom OG meta on subpages. Lapsed
      // sellers (read-only/hidden) fall back to the default meta — crawlers and
      // social bots never see premium title/description/image without an active
      // membership.
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

        const branding = resolveStallBranding(content, profileContent);

        const pageSuffix = subPage
          ? `: ${subPage.charAt(0).toUpperCase() + subPage.slice(1)}`
          : "";
        const title = branding.seo?.metaTitle
          ? `${branding.seo.metaTitle}${pageSuffix}`
          : `${branding.shopName}${pageSuffix} | Milk Market`;

        return {
          props: {
            ogMeta: buildStallOgMeta({
              branding,
              title,
              url: `/stall/${pathParts.join("/")}`,
              keywordSeed: slug,
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
            url: `/stall/${pathParts.join("/")}`,
          },
          shopPubkey: pubkey,
          ssrShopName,
          ssrShopAbout,
        },
      };
    }
  } catch (error) {
    console.error("SSR OG fetch error for shop sub-page:", error);
  }

  return {
    props: {
      ogMeta: {
        ...DEFAULT_OG,
        title: "Milk Market Stall",
        description: "Check out this shop on Milk Market!",
        url: `/stall/${pathParts.join("/")}`,
      },
      shopPubkey: "",
      ssrShopName: "",
      ssrShopAbout: "",
    },
  };
};

export default function ShopSubPage({
  shopPubkey: ssrShopPubkey,
  ssrShopName,
  ssrShopAbout,
}: ShopSubPageProps) {
  const router = useRouter();
  const { stallPath } = router.query;
  const shopMapContext = useContext(ShopMapContext);

  const pathParts = Array.isArray(stallPath) ? stallPath : [];
  const slug = pathParts[0] || "";
  const subPage = pathParts[1] || "";

  const resolveLocal = useCallback(
    () => matchShopSlug(shopMapContext.shopData, slug),
    [shopMapContext.shopData, slug]
  );

  const { state, retry } = useStorefrontLookup({
    kind: "slug",
    value: slug,
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
    return <StorefrontLoadError onRetry={retry} label="page" />;
  }

  if (state.phase === "not_found") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center pt-20">
        <h1 className="text-3xl font-bold">Page Not Found</h1>
        <p className="mt-4 text-gray-500">This page doesn&apos;t exist.</p>
        <a
          href={`/stall/${slug}`}
          className="bg-primary-blue mt-6 rounded-lg px-6 py-3 font-bold text-white transition-transform hover:-translate-y-0.5"
        >
          Back to Stall
        </a>
      </div>
    );
  }

  const shopPubkey = state.pubkey;

  if (subPage === "orders") {
    const tabParam = router.query.tab;
    const initialTab = typeof tabParam === "string" ? tabParam : undefined;
    return (
      <ThemedStallOrders
        sellerPubkey={shopPubkey}
        shopSlug={slug}
        {...(initialTab ? { initialTab } : {})}
      />
    );
  }

  return (
    <StorefrontLayout
      shopPubkey={shopPubkey}
      currentPage={subPage}
      ssrShopName={ssrShopName}
      ssrShopAbout={ssrShopAbout}
    />
  );
}
