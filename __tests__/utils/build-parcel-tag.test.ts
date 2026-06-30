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
import {
  buildParcelTag,
  republishProductWithParcel,
} from "@/utils/nostr/nostr-helper-functions";

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

/**
 * Origin-stamping behavior of `republishProductWithParcel` — the "apply parcel
 * template to listings" flow now also stamps the seller's default `ship_from_zip`
 * onto listings that lack one, because live USPS rates need BOTH a parcel weight
 * and an origin ZIP. Without the origin the buyer-side gate (liveQuoteEligible)
 * never fires a rate request and checkout silently falls back to the fixed rate
 * — the exact production bug this fix targets.
 *
 * We capture the event template inside a mock `signer.sign` (the first side
 * effect in finalizeAndSendNostrEvent) and throw to short-circuit before any
 * relay/DB publish, so these stay pure unit tests with no network.
 */
describe("republishProductWithParcel origin stamping", () => {
  const baseEvent = {
    id: "evt1",
    pubkey: "abc",
    created_at: 1000,
    kind: 30402,
    content: "{}",
    sig: "sig",
  };

  async function capture(
    tags: string[][],
    origin?: { shipFromZip?: string | null; shipFromCountry?: string | null }
  ): Promise<string[][]> {
    let capturedTags: string[][] = [];
    let signed = false;
    const signer = {
      sign: async (template: { tags: string[][] }) => {
        signed = true;
        capturedTags = template.tags;
        throw new Error("__capture__");
      },
    };
    try {
      await republishProductWithParcel(
        { ...baseEvent, tags } as never,
        { weightOz: 16 },
        signer as never,
        {} as never,
        origin
      );
    } catch {
      // expected: signer.sign throws after capturing the template
    }
    // Guard against a false pass: if signing never happened the "no stamp"
    // assertions below would trivially succeed on an empty array.
    if (!signed) {
      throw new Error("signer.sign was never called — template not captured");
    }
    return capturedTags;
  }

  it("stamps the seller default origin when the listing has no ship_from_zip", async () => {
    const tags = await capture([["d", "x"]], {
      shipFromZip: "98109",
      shipFromCountry: "us",
    });
    expect(tags).toContainEqual(["ship_from_zip", "98109", "US"]);
  });

  it("never overwrites a listing's own ship_from_zip with the default", async () => {
    const tags = await capture(
      [
        ["d", "x"],
        ["ship_from_zip", "10001", "US"],
      ],
      { shipFromZip: "98109", shipFromCountry: "US" }
    );
    const zips = tags.filter((t) => t[0] === "ship_from_zip");
    expect(zips).toEqual([["ship_from_zip", "10001", "US"]]);
  });

  it("fills the gap when the listing's existing ship_from_zip is blank", async () => {
    const tags = await capture(
      [
        ["d", "x"],
        ["ship_from_zip", "", "US"],
      ],
      { shipFromZip: "98109", shipFromCountry: "US" }
    );
    // A blank existing tag is not authoritative, so the default fills in.
    expect(tags).toContainEqual(["ship_from_zip", "98109", "US"]);
  });

  it("does not stamp an origin when the seller has no default ZIP", async () => {
    const tags = await capture([["d", "x"]], {
      shipFromZip: "",
      shipFromCountry: "US",
    });
    expect(tags.some((t) => t[0] === "ship_from_zip")).toBe(false);
  });

  it("does not stamp an origin when no origin arg is passed at all", async () => {
    const tags = await capture([["d", "x"]]);
    expect(tags.some((t) => t[0] === "ship_from_zip")).toBe(false);
  });

  it("defaults the origin country to US when it is missing", async () => {
    const tags = await capture([["d", "x"]], { shipFromZip: "98109" });
    expect(tags).toContainEqual(["ship_from_zip", "98109", "US"]);
  });

  it("keeps the parcel tag alongside the stamped origin", async () => {
    const tags = await capture([["d", "x"]], { shipFromZip: "98109" });
    expect(tags).toContainEqual(["parcel", "16"]);
  });
});
