import parseTags from "@/utils/parsers/product-parser-functions";
import { OgMetaProps, DEFAULT_OG } from "@/components/og-head";
import { NostrEvent } from "@/utils/types/types";
import { eventToUcpProduct } from "@/utils/ucp/catalog";
import { buildProductJsonLd } from "@/utils/geo/product-jsonld";

// Build OpenGraph meta for a single product event. Shared by the standalone
// listing page and by stall/custom-domain roots that serve a product as their
// landing page, so social/crawler previews stay identical (no drift).
//
// Also attaches schema.org Product/Offer JSON-LD (built from the SAME canonical
// UCP mapper the catalog/MCP surfaces use) so crawlers + AI shopping agents see
// structured data in the SSR HTML. Failure to build it never breaks OG meta.
//
// `canonicalUrl` (when provided) is the exact absolute URL the visitor's page
// canonicalizes to — friendly slug + custom-domain origin — so the JSON-LD
// Product/Offer `url` matches the page's canonical link tag instead of the raw
// `/listing/{dTag|id}` identifier URL. Omitting it preserves the default
// platform `https://milk.market/listing/{dTag|id}` link.
export function eventToProductOgMeta(
  event: NostrEvent,
  urlPath: string,
  canonicalUrl?: string
): OgMetaProps {
  const productData = parseTags(event);
  if (productData) {
    const cfg = productData.pageConfig;
    const galleryImage = cfg?.sections?.find(
      (s) => s.type === "product_gallery" && s.galleryImages?.length
    )?.galleryImages?.[0];
    let jsonLd: Record<string, unknown>[] | undefined;
    try {
      jsonLd = [
        buildProductJsonLd(
          eventToUcpProduct(event, canonicalUrl ? { canonicalUrl } : {})
        ),
      ];
    } catch {
      jsonLd = undefined;
    }
    return {
      title: cfg?.metaTitle || productData.title || "Milk Market Listing",
      description:
        cfg?.metaDescription ||
        productData.summary ||
        "Check out this product on Milk Market!",
      image:
        cfg?.ogImage ||
        productData.images?.[0] ||
        galleryImage ||
        "/milk-market.png",
      url: urlPath,
      ...(jsonLd ? { jsonLd } : {}),
    };
  }
  return {
    ...DEFAULT_OG,
    title: "Milk Market Listing",
    description: "Check out this listing on Milk Market!",
    url: urlPath,
  };
}
