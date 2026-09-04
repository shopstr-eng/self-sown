/** @jest-environment node */

// Round-trip coverage for the explicit ship-to countries listing tag
// (task #108): buildShipsToTags writes repeated ["ships_to", ISO] tags and
// parseTags reads them back into ProductData.shipsTo. Both ends validate
// against the shared ISO 3166-1 alpha-2 list — unknown codes are dropped,
// never fabricated into.

import { buildShipsToTags } from "@/utils/parsers/product-tag-helpers";
import parseTags from "@/utils/parsers/product-parser-functions";
import type { NostrEvent } from "@/utils/types/types";

function makeEvent(tags: string[][]): NostrEvent {
  return {
    id: "evt-1",
    pubkey: "ab".repeat(32),
    created_at: 1_700_000_000,
    kind: 30402,
    content: "",
    sig: "sig",
    tags,
  } as NostrEvent;
}

describe("buildShipsToTags", () => {
  it("builds sorted, deduped single-value tags from an array", () => {
    expect(buildShipsToTags(["ca", "US", "us", " MX "])).toEqual([
      ["ships_to", "CA"],
      ["ships_to", "MX"],
      ["ships_to", "US"],
    ]);
  });

  it("accepts a comma-joined string (MCP/agent input)", () => {
    expect(buildShipsToTags("us, ca")).toEqual([
      ["ships_to", "CA"],
      ["ships_to", "US"],
    ]);
  });

  it("drops unknown codes and returns undefined when none are valid", () => {
    expect(buildShipsToTags(["US", "XX", "NARNIA"])).toEqual([
      ["ships_to", "US"],
    ]);
    expect(buildShipsToTags(["XX"])).toBeUndefined();
    expect(buildShipsToTags("")).toBeUndefined();
    expect(buildShipsToTags(undefined)).toBeUndefined();
    expect(buildShipsToTags(null)).toBeUndefined();
    expect(buildShipsToTags([])).toBeUndefined();
  });
});

describe("parseTags ships_to", () => {
  it("round-trips built tags into ProductData.shipsTo", () => {
    const tags = buildShipsToTags(["US", "ca"])!;
    const parsed = parseTags(makeEvent([["title", "Raw Milk"], ...tags]));
    expect(parsed?.shipsTo).toEqual(["CA", "US"]);
  });

  it("drops unknown codes and duplicates from raw events", () => {
    const parsed = parseTags(
      makeEvent([
        ["title", "Raw Milk"],
        ["ships_to", "us"],
        ["ships_to", "US"],
        ["ships_to", "XX"],
        ["ships_to", ""],
      ])
    );
    expect(parsed?.shipsTo).toEqual(["US"]);
  });

  it("leaves shipsTo unset when no valid ships_to tag exists", () => {
    const parsed = parseTags(makeEvent([["title", "Raw Milk"]]));
    expect(parsed?.shipsTo).toBeUndefined();
  });
});
