import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWriteTools } from "@/mcp/tools/write-tools";
import { markMessagesAsRead } from "@/utils/db/db-service";

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
  markMessagesAsRead: jest.fn(),
}));

jest.mock("@/utils/mcp/auth", () => ({
  getAgentSigner: jest.fn(async () => ({
    signer: { getPubKey: () => "b".repeat(64) },
    pubkey: "b".repeat(64),
  })),
}));

jest.mock("@/utils/mcp/nostr-signing", () => ({
  McpNostrSigner: jest.fn(),
  McpRelayManager: jest.fn(),
  signAndPublishEvent: jest.fn(),
}));

const ownerPubkey = "b".repeat(64);

type Result = { content: Array<{ text: string }>; isError?: boolean };
type Callback = (
  args: Record<string, unknown>,
  extra?: unknown
) => Promise<Result>;

function tools(permissions: "full_access" | "read_only" = "full_access") {
  const callbacks = new Map<string, Callback>();
  const server = {
    registerTool: jest.fn(
      (name: string, _options: unknown, callback: Callback) =>
        callbacks.set(name, callback)
    ),
  };
  registerWriteTools(
    server as unknown as McpServer,
    {
      id: 1,
      pubkey: ownerPubkey,
      permissions,
    } as any
  );
  return callbacks;
}

function payload(result: Result) {
  return JSON.parse(result.content[0]!.text);
}

describe("mark_messages_read seller scoping", () => {
  beforeEach(() => jest.clearAllMocks());

  it("scopes the update to the API key owner's pubkey", async () => {
    jest.mocked(markMessagesAsRead).mockResolvedValue(2);
    const cb = tools().get("mark_messages_read")!;
    const messageIds = ["1".repeat(64), "2".repeat(64)];

    const result = await cb({ messageIds });

    // The regression was an unscoped UPDATE ... WHERE id = ANY($1): any
    // full_access key could flip read-state on another seller's rows.
    expect(jest.mocked(markMessagesAsRead)).toHaveBeenCalledWith(
      messageIds,
      ownerPubkey
    );
    const body = payload(result);
    expect(result.isError).toBeFalsy();
    expect(body.markedRead).toBe(2);
  });

  it("reports only the rows actually marked (cross-seller rows skipped)", async () => {
    // markMessagesAsRead filters by owner pubkey, so a key passing another
    // seller's message ids marks zero rows; the response must not claim
    // they were marked.
    jest.mocked(markMessagesAsRead).mockResolvedValue(0);
    const cb = tools().get("mark_messages_read")!;

    const result = await cb({ messageIds: ["c".repeat(64)] });

    expect(payload(result).markedRead).toBe(0);
  });

  it("rejects read_only keys without touching the database", async () => {
    const cb = tools("read_only").get("mark_messages_read")!;

    const result = await cb({ messageIds: ["1".repeat(64)] });

    expect(result.isError).toBe(true);
    expect(jest.mocked(markMessagesAsRead)).not.toHaveBeenCalled();
  });
});
