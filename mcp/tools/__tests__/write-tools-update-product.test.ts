import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EventTemplate } from "nostr-tools";
import { registerWriteTools } from "@/mcp/tools/write-tools";
import { fetchCachedEvents } from "@/utils/db/db-service";
import { signAndPublishEvent } from "@/utils/mcp/nostr-signing";

// db-service is called at module scope by utils/db/* (getDbPool), so the
// factory must provide every export write-tools imports, not just the ones
// this test drives.
jest.mock("@/utils/db/db-service", () => ({
  cacheEvent: jest.fn(),
  fetchAllProfilesFromDb: jest.fn(),
  fetchCachedEvents: jest.fn(),
  fetchCommentsByReviewIds: jest.fn(),
  createEmailFlow: jest.fn(),
  getEmailFlows: jest.fn(),
  getEmailFlow: jest.fn(),
  updateEmailFlow: jest.fn(),
  deleteEmailFlow: jest.fn(),
  createFlowStep: jest.fn(),
  getFlowSteps: jest.fn(),
  updateFlowStep: jest.fn(),
  deleteFlowStep: jest.fn(),
  getFlowEnrollments: jest.fn(),
  getSubscriptionsBySellerPubkey: jest.fn(),
  getStripeConnectAccount: jest.fn(),
  getDbPool: jest.fn(),
}));

const pubkey = "b".repeat(64);

jest.mock("@/utils/mcp/auth", () => ({
  getAgentSigner: jest.fn(async () => ({
    signer: { getPubKey: () => "b".repeat(64) },
    pubkey: "b".repeat(64),
  })),
}));

jest.mock("@/utils/mcp/nostr-signing", () => ({
  McpNostrSigner: jest.fn(),
  McpRelayManager: jest.fn(),
  signAndPublishEvent: jest.fn(
    async (_signer: unknown, template: EventTemplate) => ({
      id: "signed-event-id",
      pubkey: "b".repeat(64),
      kind: template.kind,
      created_at: template.created_at,
      tags: template.tags,
      content: template.content,
      sig: "sig",
    })
  ),
}));

type Result = { content: Array<{ text: string }>; isError?: boolean };
type Callback = (
  args: Record<string, unknown>,
  extra?: unknown
) => Promise<Result>;

function tools() {
  const callbacks = new Map<string, Callback>();
  const server = {
    registerTool: jest.fn(
      (name: string, _options: unknown, callback: Callback) =>
        callbacks.set(name, callback)
    ),
  };
  registerWriteTools(server as unknown as McpServer, {
    id: 1,
    pubkey,
    permissions: "full_access",
  } as any);
  return callbacks;
}

function payload(result: Result) {
  return JSON.parse(result.content[0]!.text);
}

function publishedTemplate(): EventTemplate {
  const calls = jest.mocked(signAndPublishEvent).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![1] as EventTemplate;
}

describe("update_product_listing marketplace discovery tag", () => {
  beforeEach(() => jest.clearAllMocks());

  it("replaces the legacy MilkMarket tag when the update omits categories", async () => {
    // Pre-rebrand listing: user category plus the legacy discovery tag. An
    // update that omits `categories` never strips "t" tags, so only the
    // normalization step keeps MilkMarket off the replacement event.
    jest.mocked(fetchCachedEvents).mockResolvedValue([
      {
        id: "legacy",
        pubkey,
        kind: 30402,
        created_at: 10,
        content: "legacy description",
        tags: [
          ["d", "listing-1"],
          ["title", "Raw Milk"],
          ["t", "MilkMarket"],
          ["t", "fresh milk"],
        ],
      },
    ] as any);

    const update = tools().get("update_product_listing")!;
    const result = payload(
      await update({ dTag: "listing-1", title: "Whole Milk" })
    );
    expect(result.success).toBe(true);

    const tTags = publishedTemplate().tags.filter((t) => t[0] === "t");
    expect(tTags.filter((t) => t[1] === "SelfSown")).toEqual([
      ["t", "SelfSown"],
    ]);
    expect(tTags.some((t) => t[1] === "MilkMarket")).toBe(false);
    // User categories survive the merge untouched.
    expect(tTags).toContainEqual(["t", "fresh milk"]);
  });

  it("still carries the discovery tag when fetching the existing event fails", async () => {
    jest
      .mocked(fetchCachedEvents)
      .mockRejectedValue(new Error("database unavailable"));

    const update = tools().get("update_product_listing")!;
    const result = payload(
      await update({ dTag: "listing-1", title: "Whole Milk" })
    );
    expect(result.success).toBe(true);

    const tTags = publishedTemplate().tags.filter((t) => t[0] === "t");
    expect(tTags).toEqual([["t", "SelfSown"]]);
  });
});
