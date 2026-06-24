/**
 * @jest-environment jsdom
 *
 * Pure-function unit tests for `buildParcelTag` — the single source of truth for
 * the NIP-99 ["parcel", weight, length?, width?, height?] tag shared by the
 * product editor (components/product-form.tsx) and the "apply parcel template to
 * listings" flow (pages/settings/shipping.tsx via republishProductWithParcel).
 *
 * Keeping this tag byte-stable matters: checkout/parseTags reads it back to
 * request live USPS rates, so any drift between the two writers silently breaks
 * rate calculation (the exact bug class this feature exists to fix).
 */
import { buildParcelTag } from "@/utils/nostr/nostr-helper-functions";

describe("buildParcelTag", () => {
  it("returns null when weight is missing, empty, zero, or non-numeric", () => {
    expect(buildParcelTag({ weightOz: "" })).toBeNull();
    expect(buildParcelTag({ weightOz: null })).toBeNull();
    expect(buildParcelTag({ weightOz: undefined })).toBeNull();
    expect(buildParcelTag({ weightOz: 0 })).toBeNull();
    expect(buildParcelTag({ weightOz: "abc" })).toBeNull();
    expect(buildParcelTag({ weightOz: -5 })).toBeNull();
  });

  it("emits weight only (no zero-padded dims) when no dimensions are given", () => {
    expect(buildParcelTag({ weightOz: 16 })).toEqual(["parcel", "16"]);
    expect(buildParcelTag({ weightOz: "16" })).toEqual(["parcel", "16"]);
  });

  it("emits full dimensions when all are positive", () => {
    expect(
      buildParcelTag({ weightOz: 16, lengthIn: 8, widthIn: 6, heightIn: 4 })
    ).toEqual(["parcel", "16", "8", "6", "4"]);
  });

  it("trims trailing empty dimensions but keeps interior blanks in slot", () => {
    // length only -> trailing width/height trimmed off
    expect(buildParcelTag({ weightOz: 16, lengthIn: 8 })).toEqual([
      "parcel",
      "16",
      "8",
    ]);
    // length + height (width missing) -> interior blank kept so height stays in
    // the height slot
    expect(buildParcelTag({ weightOz: 16, lengthIn: 8, heightIn: 4 })).toEqual([
      "parcel",
      "16",
      "8",
      "",
      "4",
    ]);
  });

  it("drops zero / non-positive dimensions", () => {
    expect(
      buildParcelTag({ weightOz: 16, lengthIn: 0, widthIn: 6, heightIn: 0 })
    ).toEqual(["parcel", "16", "", "6"]);
  });

  it("accepts numeric strings for dimensions", () => {
    expect(
      buildParcelTag({
        weightOz: "16",
        lengthIn: "8",
        widthIn: "6",
        heightIn: "4",
      })
    ).toEqual(["parcel", "16", "8", "6", "4"]);
  });

  it("preserves decimal weight and dimensions", () => {
    expect(buildParcelTag({ weightOz: 16.5, lengthIn: 8.25 })).toEqual([
      "parcel",
      "16.5",
      "8.25",
    ]);
  });
});
