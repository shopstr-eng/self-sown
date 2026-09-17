import {
  catalogEvent,
  catalogOptionTags,
} from "../../packages/domain/src/__fixtures__/seller-catalog";
import { parseTags } from "../../utils/parsers/product-parser-functions";
import {
  buildSellerListingTags,
  createSellerListingDraftFromEvent,
} from "../../packages/domain/src/listing";

test("website parses mobile size, option, choice and bundle tags without reinterpretation", () => {
  const event = catalogEvent(catalogOptionTags);
  const draft = createSellerListingDraftFromEvent(event)!;
  const tags = buildSellerListingTags({
    draft,
    pubkey: event.pubkey,
    dTag: draft.dTag!,
  });
  const parsed = parseTags({ ...event, tags });
  expect(parsed?.sizeQuantities?.get("SM")).toBe(0);
  expect(parsed?.volumePrices?.get("Quart")).toBe(12);
  expect(parsed?.weightPrices?.get("1lbs")).toBe(18);
  expect(parsed?.variantImages?.get("Vanilla")).toBe(
    "https://example.com/vanilla.jpg"
  );
  expect(parsed?.variantDisplay).toBe("dropdown");
  expect(parsed?.variantBulkPrices?.get("Quart")?.get(3)).toBe(30);
});
test("website bundle price is the total, not the per-unit price", () => {
  expect(
    parseTags(catalogEvent([["bulk", "3", "24"]]))?.bulkPrices?.get(3)
  ).toBe(24);
});
