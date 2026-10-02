import { fetchProductsByPubkeyFromDb } from "@/utils/db/db-service";
import { buildUcpCatalog } from "@/utils/ucp/catalog";
import { isBitcoinCurrency } from "@/utils/ucp/money";
import type { UcpProduct } from "@/utils/ucp/types";
import type { NostrEvent } from "@/utils/types/types";
import type { SsrProductSummary } from "@/components/storefront/storefront-layout";

/** Human-readable price for the SSR text block: "12.00 USD" / "1500 sat". */
function ssrPriceLabel(product: UcpProduct): string {
  return isBitcoinCurrency(product.price.currency)
    ? product.price.display
    : `${product.price.display} ${product.price.currency}`;
}

export function toSsrSummary(product: UcpProduct): SsrProductSummary {
  return {
    title: product.title || "Self-sown Listing",
    priceLabel: ssrPriceLabel(product),
    url: product.url,
  };
}

export type SsrStallCatalog = {
  productEvents: NostrEvent[];
  catalogProducts: UcpProduct[];
  ssrProducts: SsrProductSummary[];
};

/**
 * Bounded product fetch feeding the crawler-facing SSR text block (product
 * names/prices for ALL sellers — a stall page with only name+about is ~120
 * chars, under the ~500 chars agentic-readiness scanners ask for) and the Pro
 * ItemList JSON-LD. Shared by the stall homepage and every StorefrontLayout
 * subpage so both emit the same pre-hydration text. On a custom domain the
 * links must stay on the seller's own origin (where /listing/... is served) so
 * each URL matches the canonical page. Failure degrades to empty lists; the
 * page still renders name/about.
 */
export async function fetchSsrStallCatalog(
  pubkey: string,
  sellerOrigin?: string
): Promise<SsrStallCatalog> {
  try {
    const productEvents = await fetchProductsByPubkeyFromDb(pubkey, 50);
    const catalogProducts = buildUcpCatalog(
      productEvents,
      sellerOrigin ? { sellerOrigin } : {}
    );
    return {
      productEvents,
      catalogProducts,
      ssrProducts: catalogProducts.map(toSsrSummary),
    };
  } catch (err) {
    console.error("SSR product fetch error for stall:", err);
    return { productEvents: [], catalogProducts: [], ssrProducts: [] };
  }
}
