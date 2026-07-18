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

import { pickLatestProfileEvent } from "@/mcp/tools/read-tools";
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
