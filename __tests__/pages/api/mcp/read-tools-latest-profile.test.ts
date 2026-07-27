/**
 * profile_events keeps every version of a seller's kind-30019 shop profile
 * and kind-0 user profile. The MCP read tools (get_storefront,
 * get_company_details) must pick the NEWEST event by created_at — a bare
 * .filter(...)[0] can hand agents a stale storefront config.
 */

// read-tools.ts pulls in the whole MCP surface at module scope; stub the
// heavy transitive imports — pickLatestProfileEvent is pure.
jest.mock("@/utils/db/db-service", () => ({}));
jest.mock("@/utils/pro/membership", () => ({ getMembershipView: jest.fn() }));
jest.mock("@/mcp/tools/register-tool", () => ({ registerTool: jest.fn() }));
jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {},
}));

import {
  pickLatestProfileEvent,
  dedupLatestProfileEvents,
  pickLatestSellerProfileEvent,
} from "@/mcp/tools/read-tools";
import { NostrEvent } from "@/utils/types/types";

const makeEvent = (
  kind: number,
  pubkey: string,
  created_at: number,
  content: string
): NostrEvent => ({
  id: `${kind}-${pubkey}-${created_at}`,
  kind,
  pubkey,
  created_at,
  content,
  tags: [],
  sig: "sig",
});

describe("pickLatestProfileEvent", () => {
  const seller = "a".repeat(64);
  const other = "b".repeat(64);

  const events: NostrEvent[] = [
    makeEvent(30019, seller, 100, "old shop"),
    makeEvent(30019, seller, 300, "newest shop"),
    makeEvent(30019, seller, 200, "middle shop"),
    makeEvent(30019, other, 999, "other seller shop"),
    makeEvent(0, seller, 50, "old profile"),
    makeEvent(0, seller, 400, "newest profile"),
  ];

  it("returns the newest kind-30019 event even when an older version comes first", () => {
    expect(pickLatestProfileEvent(events, 30019, seller)?.content).toBe(
      "newest shop"
    );
  });

  it("returns the newest kind-0 event", () => {
    expect(pickLatestProfileEvent(events, 0, seller)?.content).toBe(
      "newest profile"
    );
  });

  it("only considers the requested pubkey", () => {
    expect(pickLatestProfileEvent(events, 30019, other)?.content).toBe(
      "other seller shop"
    );
  });

  it("returns undefined when no matching event exists", () => {
    expect(
      pickLatestProfileEvent(events, 30019, "c".repeat(64))
    ).toBeUndefined();
  });

  it("does not mutate the input array", () => {
    const copy = [...events];
    pickLatestProfileEvent(events, 30019, seller);
    expect(events).toEqual(copy);
  });
});

describe("pickLatestSellerProfileEvent", () => {
  const seller = "a".repeat(64);

  it("prefers the newest kind-30019 even when a newer kind-0 exists", () => {
    const events = [
      makeEvent(30019, seller, 100, "old shop"),
      makeEvent(0, seller, 500, "newest user profile"),
      makeEvent(30019, seller, 300, "newest shop"),
    ];
    expect(pickLatestSellerProfileEvent(events, seller)?.content).toBe(
      "newest shop"
    );
  });

  it("falls back to the newest kind-0 when no shop profile exists", () => {
    const events = [
      makeEvent(0, seller, 100, "old profile"),
      makeEvent(0, seller, 200, "newest profile"),
    ];
    expect(pickLatestSellerProfileEvent(events, seller)?.content).toBe(
      "newest profile"
    );
  });

  it("returns undefined for an unknown pubkey", () => {
    expect(
      pickLatestSellerProfileEvent(
        [makeEvent(30019, seller, 100, "shop")],
        "c".repeat(64)
      )
    ).toBeUndefined();
  });
});

describe("dedupLatestProfileEvents", () => {
  const seller = "a".repeat(64);
  const other = "b".repeat(64);

  const events: NostrEvent[] = [
    makeEvent(30019, seller, 100, "old shop"),
    makeEvent(30019, seller, 300, "newest shop"),
    makeEvent(30019, seller, 200, "middle shop"),
    makeEvent(30019, other, 999, "other seller shop"),
    makeEvent(0, seller, 400, "user profile"),
  ];

  it("returns at most one event per pubkey, the newest by created_at", () => {
    const result = dedupLatestProfileEvents(events, 30019);
    expect(result).toHaveLength(2);
    const contents = result.map((e) => e.content).sort();
    expect(contents).toEqual(["newest shop", "other seller shop"]);
  });

  it("only includes the requested kind", () => {
    expect(dedupLatestProfileEvents(events, 0).map((e) => e.content)).toEqual([
      "user profile",
    ]);
  });

  it("returns empty for no matching events", () => {
    expect(dedupLatestProfileEvents([], 30019)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const copy = [...events];
    dedupLatestProfileEvents(events, 30019);
    expect(events).toEqual(copy);
  });
});
