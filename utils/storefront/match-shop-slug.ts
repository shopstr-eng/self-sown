// Resolve a shop pubkey from already-loaded ShopMap (Nostr relay) data by
// matching its slug. Shared by the stall pages so the client-side fallback
// (used when the DB lookup is unavailable or hasn't indexed the slug yet) stays
// identical across them.

type ShopLike = {
  content?: {
    name?: string;
    storefront?: { shopSlug?: string };
  };
};

/** Normalize a shop name into the same slug form the app generates elsewhere. */
export function shopNameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Find the pubkey whose shop matches `slug` — first by an explicit
 * `storefront.shopSlug`, then by a name-derived slug. Returns null when nothing
 * matches (the caller should keep waiting/retrying, not declare not-found,
 * unless the authoritative API lookup also reported 404).
 */
export function matchShopSlug(
  shopData: Map<string, ShopLike>,
  slug: string
): string | null {
  if (!slug) return null;

  for (const [pubkey, shop] of shopData.entries()) {
    if (shop?.content?.storefront?.shopSlug === slug) return pubkey;
  }

  for (const [pubkey, shop] of shopData.entries()) {
    const shopName = shop?.content?.name;
    if (shopName && shopNameToSlug(shopName) === slug) return pubkey;
  }

  return null;
}
