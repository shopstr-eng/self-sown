/**
 * Discovery-tag normalization for listing replacement writers.
 *
 * Pre-rebrand listings carry the legacy ["t", "MilkMarket"] discovery tag.
 * Any flow that republishes a listing (product-page customization, parcel
 * templates, MCP updates) must rewrite the event with exactly one canonical
 * ["t", "SelfSown"] tag — never copy the legacy tag forward, and never drop
 * the discovery tag entirely when the old event can't be fetched.
 */
import { normalizeMarketplaceDiscoveryTag } from "@/utils/parsers/product-tag-helpers";
import {
  republishProductWithPageConfig,
  republishProductWithParcel,
} from "@/utils/nostr/nostr-helper-functions";

describe("normalizeMarketplaceDiscoveryTag", () => {
  it("replaces the legacy MilkMarket tag with SelfSown", () => {
    const out = normalizeMarketplaceDiscoveryTag([
      ["d", "listing-1"],
      ["t", "MilkMarket"],
      ["t", "Beef"],
    ]);
    expect(out).toEqual([
      ["d", "listing-1"],
      ["t", "Beef"],
      ["t", "SelfSown"],
    ]);
  });

  it("collapses duplicate discovery spellings to exactly one SelfSown", () => {
    const out = normalizeMarketplaceDiscoveryTag([
      ["t", "SelfSown"],
      ["t", "MilkMarket"],
      ["t", "SelfSown"],
    ]);
    expect(out.filter((t) => t[0] === "t" && t[1] === "SelfSown")).toHaveLength(
      1
    );
    expect(out.some((t) => t[1] === "MilkMarket")).toBe(false);
  });

  it("appends SelfSown when the event has no discovery tag at all", () => {
    const out = normalizeMarketplaceDiscoveryTag([["d", "listing-1"]]);
    expect(out).toEqual([
      ["d", "listing-1"],
      ["t", "SelfSown"],
    ]);
  });

  it("preserves other reserved and category tags", () => {
    const out = normalizeMarketplaceDiscoveryTag([
      ["t", "FREEMILK"],
      ["t", "SAVEBEEF"],
      ["t", "Beef"],
      ["t", "MilkMarket"],
    ]);
    expect(out).toEqual([
      ["t", "FREEMILK"],
      ["t", "SAVEBEEF"],
      ["t", "Beef"],
      ["t", "SelfSown"],
    ]);
  });
});

const baseEvent = {
  id: "evt1",
  pubkey: "abc",
  created_at: 1000,
  kind: 30402,
  content: "{}",
  sig: "sig",
};

async function captureTags(run: (signer: unknown) => Promise<unknown>) {
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
    await run(signer);
  } catch {
    // expected: signer.sign throws after capturing the template
  }
  if (!signed) {
    throw new Error("signer.sign was never called — template not captured");
  }
  return capturedTags;
}

describe("republish helpers normalize the discovery tag", () => {
  const legacyTags = [
    ["d", "listing-1"],
    ["title", "Creamline Milk"],
    ["t", "MilkMarket"],
    ["t", "Milk"],
  ];

  it("republishProductWithParcel drops MilkMarket and emits one SelfSown", async () => {
    const tags = await captureTags((signer) =>
      republishProductWithParcel(
        { ...baseEvent, tags: legacyTags } as never,
        { weightOz: 16 },
        signer as never,
        {} as never
      )
    );
    expect(tags.some((t) => t[1] === "MilkMarket")).toBe(false);
    expect(
      tags.filter((t) => t[0] === "t" && t[1] === "SelfSown")
    ).toHaveLength(1);
    expect(tags.some((t) => t[0] === "t" && t[1] === "Milk")).toBe(true);
  });

  it("republishProductWithPageConfig drops MilkMarket and emits one SelfSown", async () => {
    const tags = await captureTags((signer) =>
      republishProductWithPageConfig(
        { ...baseEvent, tags: legacyTags } as never,
        { sections: [] },
        signer as never,
        {} as never
      )
    );
    expect(tags.some((t) => t[1] === "MilkMarket")).toBe(false);
    expect(
      tags.filter((t) => t[0] === "t" && t[1] === "SelfSown")
    ).toHaveLength(1);
    expect(tags.some((t) => t[0] === "t" && t[1] === "Milk")).toBe(true);
  });
});
