import { parseTags } from "@/utils/parsers/product-parser-functions";
import type { NostrEvent } from "@/utils/types/types";

const event = (tags: string[][]): NostrEvent =>
  ({
    id: "product",
    pubkey: "seller",
    created_at: 1,
    kind: 30402,
    content: "",
    tags,
    sig: "",
  }) as NostrEvent;

describe("product subscription default", () => {
  it("parses an explicit buyer default", () => {
    expect(
      parseTags(
        event([
          ["subscription", "true"],
          ["subscription_default", "false"],
        ])
      )?.subscriptionDefaultSelected
    ).toBe(false);
  });

  it("leaves legacy listings unset so checkout defaults them off", () => {
    expect(
      parseTags(event([["subscription", "true"]]))?.subscriptionDefaultSelected
    ).toBeUndefined();
  });
});
