import {
  catalogEvent,
  catalogOptionTags,
  catalogPreservedTags,
} from "../__fixtures__/seller-catalog";
import {
  createSellerListingDraftFromEvent,
  buildSellerListingTags,
  validateSellerListingDraft,
} from "../listing";

const draftFor = (tags = catalogOptionTags) =>
  createSellerListingDraftFromEvent(catalogEvent(tags))!;
const tagsFor = (draft: ReturnType<typeof draftFor>) =>
  buildSellerListingTags({ draft, pubkey: "a".repeat(64), dTag: "farm-milk" });

describe("website product options", () => {
  test("exposes sizes including zero, priced options and custom choice images", () => {
    expect(draftFor().options).toEqual({
      sizes: [
        { label: "SM", quantity: "0" },
        { label: "LG", quantity: "4" },
      ],
      volumes: [
        { label: "Quart", price: "12" },
        { label: "Gallon", price: "40" },
      ],
      weights: [{ label: "1lbs", price: "18" }],
      choiceLabel: "Flavor",
      choices: [
        { label: "Plain" },
        { label: "Vanilla", imageUrl: "https://example.com/vanilla.jpg" },
      ],
      choiceDisplay: "dropdown",
      bundleMode: "per-option",
      bundles: [{ units: "3", totalPrice: "30", optionLabel: "Quart" }],
    });
  });
  test("replaces only edited groups and does not resurrect removed rows", () => {
    const draft = draftFor([...catalogOptionTags, ...catalogPreservedTags]);
    draft.options.sizes = [{ label: "SM", quantity: "0" }];
    draft.options.volumes[0]!.price = "11.50";
    const tags = tagsFor(draft);
    expect(tags).toContainEqual(["size", "SM", "0"]);
    expect(tags).not.toContainEqual(["size", "LG", "4"]);
    expect(tags).toContainEqual(["volume", "Quart", "11.50"]);
    for (const tag of catalogPreservedTags) expect(tags).toContainEqual(tag);
  });
  test("preserves untouched malformed, duplicate and extra-field groups", () => {
    const source = [
      ["size", "Odd", "-2", "future"],
      ["size", "Odd", "3"],
      ["variant_display", "future-display"],
    ];
    const draft = draftFor(source);
    draft.title = "New title";
    for (const tag of source) expect(tagsFor(draft)).toContainEqual(tag);
    expect(validateSellerListingDraft(draft).options).toBeUndefined();
  });
  test("rejects modification of a group that cannot be represented safely", () => {
    const draft = draftFor([["size", "Odd", "2", "future"]]);
    draft.options.sizes[0]!.quantity = "3";
    expect(validateSellerListingDraft(draft).options).toBeDefined();
    expect(() => tagsFor(draft)).toThrow();
  });
  test.each(["", "-1", "1.5", "NaN", "Infinity", "1e3", "2147483648"])(
    "rejects invalid size quantity %s",
    (quantity) => {
      const draft = draftFor();
      draft.options.sizes[0]!.quantity = quantity;
      expect(
        validateSellerListingDraft(draft).options?.["sizes.0.quantity"]
      ).toBeTruthy();
    }
  );
  test.each([
    ["USD", "1.001"],
    ["sats", "1.1"],
    ["BTC", "0.000000001"],
  ])("rejects excess precision for %s", (currency, price) => {
    const draft = draftFor();
    draft.currency = currency;
    draft.options.volumes[0]!.price = price;
    expect(
      validateSellerListingDraft(draft).options?.["volumes.0.price"]
    ).toBeTruthy();
  });
  test.each([
    ["USD", "1.001"],
    ["sats", "1.1"],
    ["BTC", "0.000000001"],
  ])("rejects excess base price precision for %s", (currency, price) => {
    const draft = draftFor();
    draft.currency = currency;
    draft.price = price;
    expect(validateSellerListingDraft(draft).price).toBeTruthy();
  });
  test.each([
    ["USD", "1.01"],
    ["SAT", "1"],
    ["btc", "0.00000001"],
  ])("accepts base price precision for %s", (currency, price) => {
    const draft = draftFor();
    draft.currency = currency;
    draft.price = price;
    expect(validateSellerListingDraft(draft).price).toBeUndefined();
  });
  test("rejects listing quantity beyond database capacity", () => {
    const draft = draftFor();
    draft.quantity = "2147483648";
    expect(validateSellerListingDraft(draft).quantity).toBeTruthy();
  });
  test("rejects duplicate options and orphan or duplicate bundle tiers", () => {
    const draft = draftFor();
    draft.options.volumes.push({ label: "Quart", price: "1" });
    draft.options.bundles.push({
      units: "3",
      totalPrice: "22",
      optionLabel: "Quart",
    });
    draft.options.bundles.push({
      units: "2",
      totalPrice: "15",
      optionLabel: "Missing",
    });
    expect(validateSellerListingDraft(draft).options).toMatchObject({
      "volumes.2.label": expect.any(String),
      "bundles.1.units": expect.any(String),
      "bundles.2.optionLabel": expect.any(String),
    });
  });
  test("clears all bundle tags when intentionally disabled", () => {
    const draft = draftFor();
    draft.options.bundleMode = "disabled";
    draft.options.bundles = [];
    expect(tagsFor(draft).filter((t) => t[0] === "bulk")).toEqual([]);
  });
  test("keeps common bundle totals and does not invent price on custom choices", () => {
    const draft = draftFor([
      ["bulk", "3", "24"],
      ["variant", "Plain"],
    ]);
    expect(draft.options.bundleMode).toBe("common");
    expect(draft.options.bundles).toEqual([{ units: "3", totalPrice: "24" }]);
    expect(tagsFor(draft)).toContainEqual(["variant", "Plain"]);
  });
  test("keeps managed tag extensions and original content through a title edit", () => {
    const event = catalogEvent(catalogPreservedTags);
    event.tags = event.tags.map((t) =>
      t[0] === "price" ? [...t, "monthly"] : t
    );
    event.content = "The authoritative full product description";
    const draft = createSellerListingDraftFromEvent(event)!;
    draft.title = "Edited";
    expect(draft.description).toBe(event.content);
    expect(tagsFor(draft)).toContainEqual(["price", "12", "USD", "monthly"]);
  });
});
