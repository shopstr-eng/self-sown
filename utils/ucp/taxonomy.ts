/**
 * Product taxonomy mapping for UCP / GEO surfaces.
 *
 * UCP catalog entries and Product/Offer JSON-LD are far more useful to shopping
 * agents and search engines when each product carries a standard taxonomy code.
 * Milk Market products only have free-form `t` category tags (see CATEGORIES),
 * so this module maps those to:
 *   - the Google Product Category full-path string (used by Merchant Center,
 *     consumed by most shopping agents), and
 *   - the Shopify Standard Product Taxonomy full-path string.
 *
 * The mapping is a best-effort default. Sellers can always override it per
 * product with explicit `google_product_category` / `shopify_product_category`
 * NIP-99 tags, which `resolveTaxonomy` prefers over the derived defaults.
 */

export interface ProductTaxonomy {
  /** Google Product Category full-path (e.g. "Food, Beverages & Tobacco > …"). */
  google?: string;
  /** Shopify Standard Product Taxonomy full-path. */
  shopify?: string;
}

// Lower-cased Milk Market category → taxonomy full paths. Top-level food
// groupings are accurate; we intentionally avoid inventing precise leaf IDs the
// platforms don't publish, keeping the defaults safe and overridable.
const GOOGLE_DAIRY = "Food, Beverages & Tobacco > Food Items > Dairy Products";
const SHOPIFY_DAIRY = "Food, Beverages & Tobacco > Food > Dairy Products";

const CATEGORY_TAXONOMY: Record<string, ProductTaxonomy> = {
  milk: {
    google: `${GOOGLE_DAIRY} > Milk`,
    shopify: `${SHOPIFY_DAIRY} > Milk`,
  },
  cheese: {
    google: `${GOOGLE_DAIRY} > Cheese`,
    shopify: `${SHOPIFY_DAIRY} > Cheese`,
  },
  yogurt: {
    google: `${GOOGLE_DAIRY} > Yogurt`,
    shopify: `${SHOPIFY_DAIRY} > Yogurt`,
  },
  butter: {
    google: `${GOOGLE_DAIRY} > Butter & Margarine`,
    shopify: `${SHOPIFY_DAIRY} > Butter`,
  },
  ghee: { google: GOOGLE_DAIRY, shopify: SHOPIFY_DAIRY },
  cream: {
    google: `${GOOGLE_DAIRY} > Cream`,
    shopify: `${SHOPIFY_DAIRY} > Cream`,
  },
  beef: {
    google: "Food, Beverages & Tobacco > Food Items > Meat",
    shopify: "Food, Beverages & Tobacco > Food > Meat",
  },
  eggs: {
    google: "Food, Beverages & Tobacco > Food Items > Eggs",
    shopify: "Food, Beverages & Tobacco > Food > Eggs",
  },
  // Broad fallbacks for the remaining Milk Market categories.
  food: {
    google: "Food, Beverages & Tobacco > Food Items",
    shopify: "Food, Beverages & Tobacco > Food",
  },
  health: {
    google: "Health & Beauty > Health Care",
    shopify: "Health & Beauty > Health Care",
  },
  pets: {
    google: "Animals & Pet Supplies > Pet Supplies > Pet Food",
    shopify: "Animals & Pet Supplies > Pet Food",
  },
};

/**
 * Best-effort Google + Shopify taxonomy for a set of free-form category tags.
 * Returns the first category that has a known mapping (categories are tried in
 * order, so the most specific tag the seller listed first wins). Returns an
 * empty object when nothing matches.
 */
export function taxonomyFromCategories(categories: string[]): ProductTaxonomy {
  for (const cat of categories) {
    const hit = CATEGORY_TAXONOMY[(cat || "").trim().toLowerCase()];
    if (hit) return hit;
  }
  return {};
}

/**
 * Resolve the final taxonomy for a product, preferring explicit per-product
 * overrides (from `google_product_category` / `shopify_product_category` tags)
 * over the defaults derived from the product's category tags. Blank overrides
 * are ignored so an empty tag never blanks out a useful default.
 */
export function resolveTaxonomy(opts: {
  categories: string[];
  googleOverride?: string | null;
  shopifyOverride?: string | null;
}): ProductTaxonomy {
  const derived = taxonomyFromCategories(opts.categories);
  const google = (opts.googleOverride || "").trim() || derived.google;
  const shopify = (opts.shopifyOverride || "").trim() || derived.shopify;
  const out: ProductTaxonomy = {};
  if (google) out.google = google;
  if (shopify) out.shopify = shopify;
  return out;
}
