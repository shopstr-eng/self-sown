import {
  catalogEvent,
  catalogOptionTags,
} from "../../packages/domain/src/__fixtures__/seller-catalog";
import { createSellerListingDraftFromEvent } from "../../packages/domain/src/listing";
import {
  changeListingBundleMode,
  removeListingOption,
  listingHasUnsavedChanges,
  assertSellerListingEditable,
} from "../../apps/mobile/lib/listing-editor-state";

const draft = () =>
  createSellerListingDraftFromEvent(catalogEvent(catalogOptionTags))!;
test("removing a priced option removes only its own bundle tiers", () => {
  const value = draft().options;
  const next = removeListingOption(value, "volumes", "Quart");
  expect(next.volumes).toEqual([{ label: "Gallon", price: "40" }]);
  expect(next.bundles).toEqual([]);
  expect(value.bundles).toHaveLength(1);
});
test("switching bundle mode discards incompatible tiers only after caller confirmation", () => {
  const value = draft().options;
  expect(changeListingBundleMode(value, "per-option")).toBe(value);
  expect(changeListingBundleMode(value, "common")).toMatchObject({
    bundleMode: "common",
    bundles: [],
  });
  expect(value.bundles).toHaveLength(1);
});
test("dirty state ignores publisher bookkeeping but notices an option price change", () => {
  const original = draft();
  const next = JSON.parse(JSON.stringify(original));
  next.sourceCreatedAt = 1800000000;
  expect(listingHasUnsavedChanges(next, original)).toBe(false);
  next.options.volumes[0]!.price = "13";
  expect(listingHasUnsavedChanges(next, original)).toBe(true);
});
test("rejects another owner's product and a newer known product revision", () => {
  const value = draft();
  const event = catalogEvent(catalogOptionTags);
  expect(() =>
    assertSellerListingEditable("c".repeat(64), value, [event])
  ).toThrow("another seller");
  const newer = {
    ...event,
    id: "2".repeat(64),
    created_at: event.created_at + 1,
  };
  expect(() =>
    assertSellerListingEditable(event.pubkey, value, [event, newer])
  ).toThrow("changed");
  expect(() => assertSellerListingEditable(event.pubkey, value, [])).toThrow(
    "no longer"
  );
  expect(() =>
    assertSellerListingEditable(event.pubkey, value, [event])
  ).not.toThrow();
});
