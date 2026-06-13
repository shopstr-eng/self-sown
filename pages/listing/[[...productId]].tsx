import { useState, useEffect, useContext, useMemo } from "react";
import { useRouter } from "next/router";
import parseTags, {
  ProductData,
} from "@/utils/parsers/product-parser-functions";
import { parseZapsnagNote } from "@/utils/parsers/zapsnag-parser";
import { ProductContext } from "../../utils/context/context";
import { nip19 } from "nostr-tools";
import { findProductBySlug, getListingSlug } from "@/utils/url-slugs";
import {
  eventMatchesListingIdentifier,
  getListingRouteIdentifier,
} from "@/utils/listing-identifiers";
import StorefrontThemeWrapper from "@/components/storefront/storefront-theme-wrapper";
import ProductListingView from "@/components/listing/product-listing-view";
import { GetServerSideProps } from "next";
import { OgMetaProps, DEFAULT_OG } from "@/components/og-head";
import {
  fetchProductByIdFromDb,
  fetchProductByDTagAndPubkey,
  fetchProductByListingSlug,
} from "@/utils/db/db-service";
import { eventToProductOgMeta } from "@/utils/og/product-og";
import { NostrEvent } from "@/utils/types/types";
import { bindAffiliateRefToSeller } from "@/components/utility-components/affiliate-ref-tracker";

type ListingPageProps = {
  ogMeta: OgMetaProps;
  initialProductEvent: NostrEvent | null;
};

type ResolvedListingState = {
  productData: ProductData;
  rawEvent: NostrEvent;
  isZapsnag: boolean;
};

function resolveListingStateFromEvent(
  event: NostrEvent | null | undefined
): ResolvedListingState | undefined {
  if (!event) {
    return;
  }

  if (event.kind === 1) {
    const productData = parseZapsnagNote(event);
    if (!productData) {
      return;
    }

    return {
      productData,
      rawEvent: event,
      isZapsnag: true,
    };
  }

  const productData = parseTags(event);
  if (!productData) {
    return;
  }

  return {
    productData,
    rawEvent: event,
    isZapsnag: false,
  };
}

const LISTING_FALLBACK: OgMetaProps = {
  ...DEFAULT_OG,
  title: "Milk Market Listing",
  description: "Check out this listing on Milk Market!",
};

export const getServerSideProps: GetServerSideProps<ListingPageProps> = async (
  context
) => {
  const { productId } = context.query;
  const identifier = getListingRouteIdentifier(productId);

  if (!identifier) {
    return { props: { ogMeta: LISTING_FALLBACK, initialProductEvent: null } };
  }

  const urlPath = `/listing/${identifier}`;

  try {
    if (identifier.startsWith("naddr1")) {
      try {
        const decoded = nip19.decode(identifier);
        if (decoded.type === "naddr") {
          const event = await fetchProductByDTagAndPubkey(
            decoded.data.identifier,
            decoded.data.pubkey
          );
          if (event) {
            return {
              props: {
                ogMeta: eventToProductOgMeta(event, urlPath),
                initialProductEvent: event,
              },
            };
          }
        }
      } catch {}
      return {
        props: {
          ogMeta: { ...LISTING_FALLBACK, url: urlPath },
          initialProductEvent: null,
        },
      };
    }

    const eventById = await fetchProductByIdFromDb(identifier);
    if (eventById) {
      return {
        props: {
          ogMeta: eventToProductOgMeta(eventById, urlPath),
          initialProductEvent: eventById,
        },
      };
    }

    const eventBySlug = await fetchProductByListingSlug(identifier);
    if (eventBySlug) {
      return {
        props: {
          ogMeta: eventToProductOgMeta(eventBySlug, urlPath),
          initialProductEvent: eventBySlug,
        },
      };
    }
  } catch (error) {
    console.error("SSR OG fetch error for listing:", error);
  }

  return {
    props: {
      ogMeta: { ...LISTING_FALLBACK, url: urlPath },
      initialProductEvent: null,
    },
  };
};

const Listing = ({ initialProductEvent }: ListingPageProps) => {
  const router = useRouter();
  const seededListing = useMemo(
    () => resolveListingStateFromEvent(initialProductEvent),
    [initialProductEvent]
  );
  const [productData, setProductData] = useState<ProductData | undefined>(
    seededListing?.productData
  );
  const [isZapsnag, setIsZapsnag] = useState(seededListing?.isZapsnag ?? false);
  const [productIdString, setProductIdString] = useState("");
  const [rawEvent, setRawEvent] = useState<NostrEvent | undefined>(
    seededListing?.rawEvent
  );
  const [sfSellerPubkey, setSfSellerPubkey] = useState("");
  const [isListingNotFound, setIsListingNotFound] = useState(false);

  const productContext = useContext(ProductContext);

  // When the listing was opened via a stall-scoped URL
  // (e.g. /stall/<slug>/listing/<productSlug>, internally rewritten with
  // ?_sf=<slug>), eagerly resolve the shop pubkey + slug so the storefront
  // theme wraps the page even on direct loads / refreshes / shared links.
  useEffect(() => {
    if (!router.isReady) return;
    const sfParam = router.query._sf;
    const sfSlug = Array.isArray(sfParam) ? sfParam[0] : sfParam;
    if (!sfSlug) return;
    if (sfSellerPubkey) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/storefront/lookup?slug=${encodeURIComponent(sfSlug)}`
        );
        if (!cancelled && res.ok) {
          const data = await res.json();
          if (data?.pubkey) {
            sessionStorage.setItem("sf_seller_pubkey", data.pubkey);
            sessionStorage.setItem("sf_shop_slug", sfSlug);
            setSfSellerPubkey(data.pubkey);
          }
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [router.isReady, router.query._sf, sfSellerPubkey]);

  useEffect(() => {
    if (router.isReady) {
      const { productId } = router.query;
      const resolvedProductId = getListingRouteIdentifier(productId);
      setProductIdString(resolvedProductId);
      if (!resolvedProductId) {
        router.push("/marketplace");
      }
    }
  }, [router, router.isReady, router.query.productId]);

  useEffect(() => {
    if (seededListing) {
      setProductData(seededListing.productData);
      setRawEvent(seededListing.rawEvent);
      setIsZapsnag(seededListing.isZapsnag);
    } else {
      setProductData(undefined);
      setRawEvent(undefined);
      setIsZapsnag(false);
    }
    setIsListingNotFound(false);
  }, [seededListing]);

  useEffect(() => {
    if (!router.isReady || !productIdString) {
      return;
    }

    if (productContext.isLoading || !productContext.productEvents) {
      setIsListingNotFound(false);
      return;
    }

    if (!productContext.isLoading && productContext.productEvents) {
      const allParsed = productContext.productEvents
        .filter((e: NostrEvent) => e.kind !== 1)
        .map((e: NostrEvent) => parseTags(e))
        .filter((p: ProductData | undefined): p is ProductData => !!p);

      let matchingEvent: NostrEvent | undefined;

      const slugMatch = findProductBySlug(productIdString, allParsed);
      if (slugMatch) {
        matchingEvent = productContext.productEvents.find(
          (e: NostrEvent) => e.id === slugMatch.id
        );
      }

      if (!matchingEvent) {
        matchingEvent = productContext.productEvents.find((event: NostrEvent) =>
          eventMatchesListingIdentifier(event, productIdString)
        );
      }

      if (matchingEvent) {
        if (sfSellerPubkey && matchingEvent.pubkey !== sfSellerPubkey) {
          setSfSellerPubkey("");
          sessionStorage.removeItem("sf_seller_pubkey");
          sessionStorage.removeItem("sf_shop_slug");
          localStorage.removeItem("sf_seller_pubkey");
          localStorage.removeItem("sf_shop_slug");
        }
        // Bind any pending `?ref=CODE` to the actual product seller now that
        // we know who they are. This catches direct listing visits (including
        // from custom domains) where the affiliate tracker only had the
        // wildcard slot to work with at first paint.
        bindAffiliateRefToSeller(matchingEvent.pubkey, router.asPath);
        // Also seed sf_seller_pubkey so the cart / checkout pick up the
        // seller for per-seller cookie + affiliate lookups.
        try {
          if (typeof window !== "undefined" && window.sessionStorage) {
            const existing = window.sessionStorage.getItem("sf_seller_pubkey");
            if (!existing) {
              window.sessionStorage.setItem(
                "sf_seller_pubkey",
                matchingEvent.pubkey
              );
            }
          }
        } catch {
          // sessionStorage unavailable; ignore.
        }
        const resolvedListing = resolveListingStateFromEvent(matchingEvent);
        if (resolvedListing) {
          setRawEvent(resolvedListing.rawEvent);
          setProductData(resolvedListing.productData);
          setIsZapsnag(resolvedListing.isZapsnag);
          setIsListingNotFound(false);
          return;
        }

        setRawEvent(matchingEvent);
        setProductData(undefined);
        setIsZapsnag(false);
        setIsListingNotFound(!seededListing);
      } else if (!seededListing && productContext.productEvents.length > 0) {
        setRawEvent(undefined);
        setProductData(undefined);
        setIsZapsnag(false);
        setIsListingNotFound(true);
      }
    }
  }, [
    productContext.isLoading,
    productContext.productEvents,
    productIdString,
    router,
    router.isReady,
    seededListing,
    sfSellerPubkey,
  ]);

  useEffect(() => {
    if (
      !router.isReady ||
      !productIdString ||
      !productData ||
      isZapsnag ||
      productContext.isLoading
    ) {
      return;
    }

    const allParsed = productContext.productEvents
      .filter((event: NostrEvent) => event.kind !== 1)
      .map((event: NostrEvent) => parseTags(event))
      .filter(
        (parsed: ProductData | undefined): parsed is ProductData => !!parsed
      );

    if (
      rawEvent &&
      rawEvent.kind !== 1 &&
      !allParsed.some((parsed: ProductData) => parsed.id === rawEvent.id)
    ) {
      const parsedRawEvent = parseTags(rawEvent);
      if (parsedRawEvent) {
        allParsed.push(parsedRawEvent);
      }
    }

    const canonicalSlug = getListingSlug(productData, allParsed);
    if (canonicalSlug && productIdString !== canonicalSlug) {
      const sfParam = router.query._sf;
      const sfSlug = Array.isArray(sfParam) ? sfParam[0] : sfParam;
      const target = sfSlug
        ? `/stall/${sfSlug}/listing/${canonicalSlug}`
        : `/listing/${canonicalSlug}`;
      router.replace(target, undefined, {
        shallow: true,
      });
    }
  }, [
    productContext.isLoading,
    productContext.productEvents,
    productData,
    productIdString,
    rawEvent,
    router,
    router.isReady,
    isZapsnag,
  ]);

  const sellerPubkey = productData?.pubkey || "";

  const view = (
    <ProductListingView
      productData={productData}
      rawEvent={rawEvent}
      isZapsnag={isZapsnag}
      isListingNotFound={isListingNotFound}
    />
  );

  if (sellerPubkey) {
    return (
      <StorefrontThemeWrapper sellerPubkey={sellerPubkey} renderChrome={true}>
        {view}
      </StorefrontThemeWrapper>
    );
  }

  return view;
};

export default Listing;
