import HomeFeed from "@/components/home/home-feed";
import { GetServerSideProps } from "next";
import { OgMetaProps, DEFAULT_OG } from "@/components/og-head";
import { nip19 } from "nostr-tools";
import {
  fetchShopProfileByPubkeyFromDb,
  fetchProfilePubkeyByNameSlug,
  fetchProductsByPubkeyFromDb,
  getShopSlugByPubkey,
} from "@/utils/db/db-service";
import parseTags from "@/utils/parsers/product-parser-functions";

type SsrProduct = { id: string; title: string };

type MarketplacePageProps = {
  ogMeta: OgMetaProps;
  initialFocusedPubkey: string;
  ssrSellerName: string;
  ssrSellerAbout: string;
  ssrProducts: SsrProduct[];
  focusedPubkey: string;
  setFocusedPubkey: (value: string) => void;
  selectedSection: string;
  setSelectedSection: (value: string) => void;
};

function shopEventToOgMeta(
  shopEvent: import("@/utils/types/types").NostrEvent,
  urlPath: string
): OgMetaProps {
  try {
    const content = JSON.parse(shopEvent.content);
    return {
      title: content.name ? `${content.name} Stall` : "Milk Market Stall",
      description: content.about || "Check out this shop on Milk Market!",
      image: content.ui?.picture || "/milk-market.png",
      url: urlPath,
    };
  } catch {
    return {
      ...DEFAULT_OG,
      title: "Milk Market Stall",
      description: "Check out this shop on Milk Market!",
      url: urlPath,
    };
  }
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const { npub } = context.query;
  const identifier = Array.isArray(npub) ? npub[0] : npub;

  if (!identifier) {
    return {
      props: {
        ogMeta: {
          title: "Milk Market - Browse Local Food Producers",
          description:
            "Discover farms, dairies, and local food producers on Milk Market. Shop raw milk, pastured meats, fresh eggs, and more directly from sellers near you.",
          image: "/milk-market.png",
          url: "/marketplace",
        } as OgMetaProps,
        initialFocusedPubkey: "",
        ssrSellerName: "",
      },
    };
  }

  const urlPath = `/marketplace/${identifier}`;

  try {
    let pubkey: string | null = null;

    if (identifier.startsWith("npub1")) {
      try {
        const decoded = nip19.decode(identifier);
        if (decoded.type === "npub") {
          pubkey = decoded.data as string;
        }
      } catch {}

      // Redirect npub URLs to their canonical slug so crawlers always land on
      // the stable slug URL instead of the raw public key.
      if (pubkey) {
        const canonicalSlug = await getShopSlugByPubkey(pubkey);
        if (canonicalSlug) {
          return {
            redirect: {
              destination: `/marketplace/${canonicalSlug}`,
              permanent: true,
            },
          };
        }
      }
    } else {
      pubkey = await fetchProfilePubkeyByNameSlug(identifier);
    }

    if (!pubkey) {
      return { notFound: true };
    }

    // For slug-based identifiers, check whether the request used the canonical
    // registered shop slug. If not, redirect to it so all seller marketplace
    // pages consolidate authority onto one stable URL.
    if (!identifier.startsWith("npub1")) {
      const canonicalShopSlug = await getShopSlugByPubkey(pubkey);
      if (canonicalShopSlug && canonicalShopSlug !== identifier) {
        return {
          redirect: {
            destination: `/marketplace/${canonicalShopSlug}`,
            permanent: true,
          },
        };
      }
    }

    const shopEvent = await fetchShopProfileByPubkeyFromDb(pubkey);
    if (!shopEvent) {
      // Pubkey exists but no shop profile — nothing to show.
      return { notFound: true };
    }

    let ssrSellerName = "";
    let ssrSellerAbout = "";
    try {
      const c = JSON.parse(shopEvent.content);
      ssrSellerName = c.name || "";
      ssrSellerAbout = c.about || "";
    } catch {}

    // Fetch a slice of the seller's products for the SSR HTML so crawlers
    // and bots that don't run JavaScript see real listing links immediately.
    let ssrProducts: SsrProduct[] = [];
    try {
      const productEvents = await fetchProductsByPubkeyFromDb(pubkey, 24);
      ssrProducts = productEvents
        .map((e) => {
          const parsed = parseTags(e);
          return parsed ? { id: e.id, title: parsed.title || "" } : null;
        })
        .filter((p): p is SsrProduct => !!p && !!p.title)
        .slice(0, 24);
    } catch {
      // Non-fatal: SSR product slice is best-effort.
    }

    // Use the canonical slug in ogMeta.url so the canonical tag always
    // points at the slug URL regardless of which identifier was requested.
    const canonicalSlug = identifier.startsWith("npub1") ? null : identifier;
    const canonicalUrl = canonicalSlug
      ? `/marketplace/${canonicalSlug}`
      : urlPath;
    return {
      props: {
        ogMeta: shopEventToOgMeta(shopEvent, canonicalUrl),
        initialFocusedPubkey: pubkey,
        ssrSellerName,
        ssrSellerAbout,
        ssrProducts,
      },
    };
  } catch (error) {
    console.error("SSR OG fetch error for marketplace:", error);
  }

  return {
    props: {
      ogMeta: {
        ...DEFAULT_OG,
        title: "Milk Market Stall",
        description: "Check out this shop on Milk Market!",
        url: urlPath,
      },
      initialFocusedPubkey: "",
      ssrSellerName: "",
      ssrSellerAbout: "",
      ssrProducts: [],
    },
  };
};

export default function SellerView({
  focusedPubkey,
  setFocusedPubkey,
  selectedSection,
  setSelectedSection,
  ssrSellerName = "",
  ssrSellerAbout = "",
  ssrProducts = [],
  initialFocusedPubkey = "",
}: MarketplacePageProps) {
  const isSeller = !!(focusedPubkey || initialFocusedPubkey);
  return (
    <>
      {isSeller && ssrSellerName ? (
        <h1 className="sr-only">{ssrSellerName} — Milk Market Stall</h1>
      ) : (
        <h1 className="sr-only">
          Milk Market — raw milk &amp; farm-fresh dairy marketplace
        </h1>
      )}
      {/* SSR-rendered seller intro: in the initial HTML for crawlers and bots
          that don't execute JavaScript. Contains the seller description and
          crawlable listing links so search engines can index the stall's
          catalog from the first response. Hidden after JS hydrates since
          HomeFeed renders the full interactive product grid. */}
      {isSeller && ssrSellerName && (
        <section
          aria-label={`${ssrSellerName} products`}
          className="w-full border-b border-gray-100 bg-white px-4 pt-24 pb-6"
          suppressHydrationWarning
        >
          <div className="mx-auto max-w-6xl">
            <p className="text-base text-gray-700">{ssrSellerAbout}</p>
            {ssrProducts.length > 0 && (
              <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
                {ssrProducts.map((p) => (
                  <li key={p.id}>
                    <a
                      href={`/listing/${p.id}`}
                      className="text-sm font-medium text-blue-700 hover:underline"
                    >
                      {p.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
      {!focusedPubkey && !initialFocusedPubkey && (
        <div className="flex h-auto w-full items-center justify-center bg-black bg-cover bg-center pt-20">
          <img
            src="/free-milk.png"
            alt="Milk Market Banner"
            className="max-h-[300px] w-full items-center justify-center object-contain py-8"
            fetchPriority="high"
          />
        </div>
      )}
      <div
        className={`flex h-full min-h-screen flex-col bg-white ${
          focusedPubkey || initialFocusedPubkey ? "pt-20" : ""
        }`}
      >
        <HomeFeed
          focusedPubkey={focusedPubkey}
          setFocusedPubkey={setFocusedPubkey}
          selectedSection={selectedSection}
          setSelectedSection={setSelectedSection}
          ssrSellerName={ssrSellerName}
        />
      </div>
    </>
  );
}
