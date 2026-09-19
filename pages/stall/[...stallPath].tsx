import { useCallback, useContext } from "react";
import { useRouter } from "next/router";
import { ShopMapContext } from "@/utils/context/context";
import StorefrontLayout from "@/components/storefront/storefront-layout";
import StorefrontLoadError from "@/components/storefront/storefront-load-error";
import ThemedStallOrders from "@/components/storefront/themed-stall-orders";
import ThemedBlog from "@/components/storefront/themed-blog";
import SelfSownSpinner from "@/components/utility-components/ss-spinner";
import { useStorefrontLookup } from "@/utils/storefront/use-storefront-lookup";
import { matchShopSlug } from "@/utils/storefront/match-shop-slug";
import { GetServerSideProps } from "next";
import { OgMetaProps, DEFAULT_OG } from "@/components/og-head";
import {
  fetchShopPubkeyBySlug,
  fetchShopProfileByPubkeyFromDb,
  fetchProfileByPubkeyFromDb,
  fetchBlogPostsByPubkeyFromDb,
} from "@/utils/db/db-service";
import { parseBlogPostEvent, type BlogPost } from "@self-sown/domain";
import { findBlogPostBySlug } from "@/utils/url-slugs";
import { eventToBlogOgMeta } from "@/utils/og/blog-og";
import {
  resolveStallBranding,
  buildStallOgMeta,
} from "@/utils/storefront/stall-branding";
import { getMembershipView } from "@/utils/pro/membership";
import { tryWriteAgentNotFound } from "@/utils/api/agent-error";
import { SITE_URL } from "@/utils/site-url";
import {
  POLICY_SLUGS,
  resolveStorefrontPolicy,
} from "@/utils/storefront-policies";
import {
  STOREFRONT_BUILTIN_SUBPAGES,
  STOREFRONT_GATED_SUBPAGES,
} from "@/utils/storefront-links";
import type { StorefrontPolicies } from "@/utils/types/types";

type ShopSubPageProps = {
  ogMeta: OgMetaProps;
  shopPubkey: string;
  ssrShopName: string;
  ssrShopAbout: string;
  ssrStoreUrl: string;
  ssrBlogPosts: import("@self-sown/domain").BlogPost[] | null;
};

export const getServerSideProps: GetServerSideProps<ShopSubPageProps> = async (
  context
) => {
  const { stallPath } = context.query;
  const pathParts = Array.isArray(stallPath) ? stallPath : [];
  const slug = pathParts[0] || "";

  // Resolve canonical stall root URL (same logic as [slug].tsx) so structured
  // data on sub-pages uses the correct origin on custom domains.
  const rawHost = context.req.headers["x-ss-custom-domain-host"];
  const customHost = (typeof rawHost === "string" ? rawHost : "")
    .toLowerCase()
    .trim()
    .replace(/:\d+$/, "");
  const rawOriginalPath = context.req.headers["x-ss-original-path"];
  const originalPath =
    typeof rawOriginalPath === "string" ? rawOriginalPath : "";
  const stallOrigin = customHost ? `https://${customHost}` : SITE_URL;
  const stallRootPath = customHost
    ? originalPath?.split("/").slice(0, 2).join("/") || "/"
    : `/stall/${slug}`;
  const canonicalStallUrl = `${stallOrigin}${stallRootPath === "/" ? "" : stallRootPath}`;

  // Content-negotiated 404: agents asking for markdown/JSON get a structured
  // body with discovery hints (on custom domains the message names the public
  // path, not the internal /stall/* rewrite); browsers fall through to the
  // standard HTML 404 page.
  const stallNotFound = () => {
    const notFoundPath = customHost
      ? originalPath || "/"
      : `/stall/${pathParts.join("/")}`;
    if (tryWriteAgentNotFound(context.req, context.res, notFoundPath)) {
      return { props: {} as ShopSubPageProps };
    }
    return { notFound: true } as const;
  };

  if (!slug) {
    return {
      props: {
        ogMeta: DEFAULT_OG,
        shopPubkey: "",
        ssrShopName: "",
        ssrShopAbout: "",
        ssrStoreUrl: "",
        ssrBlogPosts: null,
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

      // Validate the subPage server-side so unknown /stall/<slug>/<anything>
      // routes return a real 404 instead of a soft one. The allowlist must
      // mirror what StorefrontLayout actually renders: the ungated built-ins
      // (shared RESERVED set minus the gated pair), wallet/community only when
      // the seller enabled their flags (renderer shows its own Not Found
      // otherwise), policy slugs resolved exactly like the renderer
      // (policies[key] || defaults[key], then require enabled), and custom
      // pages NESTED at content.storefront.pages routed by SLUG only —
      // matching top-level c.pages or p.id accepts routes the renderer can't
      // render. Extra path segments beyond blog/<post> are never a route.
      const hasExtraSegments = pathParts.length > (subPage === "blog" ? 3 : 2);
      if (subPage && hasExtraSegments) {
        return stallNotFound();
      }
      if (subPage && !STOREFRONT_BUILTIN_SUBPAGES.has(subPage)) {
        let validSubPage = false;
        if (shopEvent) {
          try {
            const c = JSON.parse(shopEvent.content);
            const raw =
              c && typeof c.storefront === "object" && c.storefront
                ? c.storefront
                : {};
            // The client strips all premium storefront config for non-Pro
            // sellers (basicStorefront keeps only shopSlug/customDomain), so
            // validate against the same effective config — otherwise SSR 200s
            // routes the client renders as fallback sections or Not Found.
            const sf = membership.isPro === true ? raw : {};
            const gatedFlag = (STOREFRONT_GATED_SUBPAGES as Record<string, string>)[
              subPage
            ];
            if (gatedFlag) {
              validSubPage = sf[gatedFlag] === true;
            } else {
              const policyKey = (
                Object.keys(POLICY_SLUGS) as (keyof StorefrontPolicies)[]
              ).find((k) => POLICY_SLUGS[k] === subPage);
              if (policyKey) {
                // Shared resolver, same truthiness as the renderer/footer:
                // stored wins when present (truthy enabled), absent/null falls
                // back to the default policy (enabled).
                validSubPage = !!resolveStorefrontPolicy(
                  sf.footer?.policies,
                  policyKey,
                  ssrShopName
                );
              } else {
                const pages = Array.isArray(sf.pages) ? sf.pages : [];
                validSubPage = pages.some(
                  (p: { slug?: string }) => p?.slug === subPage
                );
              }
            }
          } catch {}
        }
        if (!validSubPage) {
          return stallNotFound();
        }
      }

      // Blog routes: fetch posts server-side for ALL sellers (not just Pro) so
      // the initial HTML contains the article body or archive links for crawlers,
      // and so we can return a real 404 when the post slug doesn't resolve. Pro
      // status only gates premium OG branding, not whether the content is served.
      if (subPage === "blog") {
        try {
          const events = await fetchBlogPostsByPubkeyFromDb(pubkey);
          const parsed = events
            .map((e) => parseBlogPostEvent(e))
            .filter((p): p is BlogPost => p !== null);

          if (pathParts[2]) {
            // Single blog post.
            const match = findBlogPostBySlug(pathParts[2], parsed);
            if (match) {
              const raw = events.find((e) => e.id === match.id);
              if (raw) {
                return {
                  props: {
                    ogMeta: eventToBlogOgMeta(
                      raw,
                      `/stall/${pathParts.join("/")}`,
                      ssrShopName ? { authorName: ssrShopName } : {}
                    ),
                    shopPubkey: pubkey,
                    ssrShopName,
                    ssrShopAbout,
                    ssrStoreUrl: canonicalStallUrl,
                    ssrBlogPosts: parsed,
                  },
                };
              }
            }
            // Blog post slug not found — return a real 404 instead of a soft one.
            return stallNotFound();
          } else {
            // Blog index: seed with SSR posts so crawlers see archive links in
            // the first HTML response. The component routes this to ThemedBlog.
            const ogTitle = ssrShopName
              ? `${ssrShopName} Blog | Self-sown`
              : "Self-sown Stall Blog";
            return {
              props: {
                ogMeta: {
                  ...DEFAULT_OG,
                  title: ogTitle,
                  description:
                    ssrShopAbout || "Read the latest posts from this seller.",
                  url: `/stall/${slug}/blog`,
                },
                shopPubkey: pubkey,
                ssrShopName,
                ssrShopAbout,
                ssrStoreUrl: canonicalStallUrl,
                ssrBlogPosts: parsed,
              },
            };
          }
        } catch (err) {
          console.error("SSR blog OG fetch error:", err);
        }
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
          : `${branding.shopName}${pageSuffix} | Self-sown`;

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
            ssrStoreUrl: canonicalStallUrl,
            ssrBlogPosts: null,
          },
        };
      }
      // Non-Pro sellers: still emit unique per-seller metadata so search
      // engines can distinguish stall sub-pages from each other.
      return {
        props: {
          ogMeta: {
            ...DEFAULT_OG,
            title: ssrShopName
              ? `${ssrShopName} | Self-sown`
              : "Self-sown Stall",
            description: ssrShopAbout || "Check out this shop on Self-sown!",
            url: `/stall/${pathParts.join("/")}`,
          },
          shopPubkey: pubkey,
          ssrShopName,
          ssrShopAbout,
          ssrStoreUrl: canonicalStallUrl,
          ssrBlogPosts: null,
        },
      };
    }
    // Slug found no matching pubkey — this stall page doesn't exist.
    return stallNotFound();
  } catch (error) {
    console.error("SSR OG fetch error for shop sub-page:", error);
  }

  return {
    props: {
      ogMeta: {
        ...DEFAULT_OG,
        title: "Self-sown Stall",
        description: "Check out this shop on Self-sown!",
        url: `/stall/${pathParts.join("/")}`,
      },
      shopPubkey: "",
      ssrShopName: "",
      ssrShopAbout: "",
      ssrStoreUrl: "",
      ssrBlogPosts: null,
    },
  };
};

export default function ShopSubPage({
  shopPubkey: ssrShopPubkey,
  ssrShopName,
  ssrShopAbout,
  ssrStoreUrl,
  ssrBlogPosts,
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
        <SelfSownSpinner />
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

  // Both the blog index (/blog) and individual article (/blog/<slug>) render
  // through ThemedBlog so the initial HTML is server-seeded with post content
  // and archive links that crawlers can index without executing JavaScript.
  if (subPage === "blog") {
    const postSlug = pathParts[2];
    return (
      <ThemedBlog
        sellerPubkey={shopPubkey}
        shopSlug={slug}
        postSlug={postSlug}
        ssrPosts={ssrBlogPosts ?? undefined}
      />
    );
  }

  return (
    <StorefrontLayout
      shopPubkey={shopPubkey}
      currentPage={subPage}
      ssrShopName={ssrShopName}
      ssrShopAbout={ssrShopAbout}
      ssrStoreUrl={ssrStoreUrl || undefined}
    />
  );
}
