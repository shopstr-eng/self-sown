import parseTags from "@/utils/parsers/product-parser-functions";
import { OgMetaProps, DEFAULT_OG } from "@/components/og-head";
import { NostrEvent } from "@/utils/types/types";

// Build OpenGraph meta for a single product event. Shared by the standalone
// listing page and by stall/custom-domain roots that serve a product as their
// landing page, so social/crawler previews stay identical (no drift).
export function eventToProductOgMeta(
  event: NostrEvent,
  urlPath: string
): OgMetaProps {
  const productData = parseTags(event);
  if (productData) {
    const cfg = productData.pageConfig;
    const galleryImage = cfg?.sections?.find(
      (s) => s.type === "product_gallery" && s.galleryImages?.length
    )?.galleryImages?.[0];
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
    };
  }
  return {
    ...DEFAULT_OG,
    title: "Milk Market Listing",
    description: "Check out this listing on Milk Market!",
    url: urlPath,
  };
}
