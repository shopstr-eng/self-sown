import type { NostrEventRecord, PosCatalogItem } from "@self-sown/domain";

const HEX_64 = /^[0-9a-f]{64}$/i;

function getTagValues(event: NostrEventRecord, key: string): string[] {
  return event.tags.filter((t) => t[0] === key).map((t) => t[1] ?? "");
}

/**
 * Build the PoS picker catalog from the seller's own kind:30402 events.
 * Active, titled, priced listings only; latest version per d-tag (the per-
 * seller API already dedups, this is the client-side backstop). Variant-scoped
 * bulk tags (["bulk", units, price, variantName]) are skipped — the PoS sells
 * the base listing, so only base tiers apply.
 */
export function buildPosCatalog(
  events: NostrEventRecord[],
  sellerPubkey: string
): PosCatalogItem[] {
  const byDTag = new Map<string, NostrEventRecord>();
  for (const event of events) {
    if (event.kind !== 30402) continue;
    if (event.pubkey.toLowerCase() !== sellerPubkey.toLowerCase()) continue;
    const dTag = getTagValues(event, "d")[0] ?? "";
    if (!dTag) continue;
    const existing = byDTag.get(dTag);
    if (!existing || Number(event.created_at) > Number(existing.created_at)) {
      byDTag.set(dTag, event);
    }
  }

  const items: PosCatalogItem[] = [];
  for (const [dTag, event] of byDTag) {
    if (getTagValues(event, "status")[0] === "inactive") continue;
    const title = getTagValues(event, "title")[0]?.trim() ?? "";
    const priceTag = event.tags.find((t) => t[0] === "price");
    const price = priceTag?.[1] ? Number(priceTag[1]) : NaN;
    const currency = (priceTag?.[2] ?? "USD").trim().toUpperCase();
    if (!title || !Number.isFinite(price) || price < 0 || !currency) continue;

    const bulkPrices = new Map<number, number>();
    for (const tag of event.tags) {
      if (tag[0] !== "bulk" || tag.length !== 3) continue;
      const units = Number(tag[1]);
      const bundlePrice = Number(tag[2]);
      if (
        Number.isInteger(units) &&
        units >= 2 &&
        Number.isFinite(bundlePrice) &&
        bundlePrice > 0
      ) {
        bulkPrices.set(units, bundlePrice);
      }
    }

    const image = getTagValues(event, "image")[0]?.trim() || undefined;
    items.push({
      address: `30402:${event.pubkey}:${dTag}`,
      dTag,
      title,
      price,
      currency,
      ...(bulkPrices.size > 0 ? { bulkPrices } : {}),
      ...(image ? { image } : {}),
    });
  }

  return items.sort((a, b) => a.title.localeCompare(b.title));
}

export function isValidSellerPubkey(pubkey: string): boolean {
  return HEX_64.test(pubkey);
}
