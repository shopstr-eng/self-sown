// SSRF regression tests for send_cashu_payment: the tool takes a
// caller-supplied mintUrl, so a private/loopback mint must be rejected
// BEFORE the Cashu SDK is given the URL — the SDK's own fetch resolves DNS
// itself, so the guard has to fire ahead of any network activity. Public
// mints must be constructed with the guarded safeFetch transport
// (createGuardedMintRequest), never the SDK default.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWriteTools } from "@/mcp/tools/write-tools";

// db-service is called at module scope by utils/db/* (getDbPool), so the
// factory must provide every export write-tools imports, not just the ones
// this test drives.
jest.mock("@/utils/db/db-service", () => ({
  cacheEvent: jest.fn(),
  fetchAllProfilesFromDb: jest.fn(),
  fetchCachedEvents: jest.fn(async () => []),
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
  canUsePurchaseTools: () => true,
  canUseSellerReadTools: () => true,
  canUseSellerWriteTools: (k: any) => k.permissions === "full_access",
  getAgentSigner: jest.fn(async () => ({
    signer: {
      getPubKey: () => "b".repeat(64),
      decrypt: (_p: string, content: string) => content,
      encrypt: (_p: string, content: string) => content,
    },
    pubkey: "b".repeat(64),
  })),
}));

jest.mock("@/utils/mcp/nostr-signing", () => ({
  McpNostrSigner: jest.fn(),
  McpRelayManager: jest.fn(),
  signAndPublishEvent: jest.fn(),
}));

// Track CashuMint construction: a rejected mintUrl must never reach the SDK,
// and an accepted one must carry the guarded customRequest transport.
const mintCtor = jest.fn();
jest.mock("@cashu/cashu-ts", () => ({
  Mint: jest.fn().mockImplementation((...args: any[]) => {
    mintCtor(...args);
    return {};
  }),
  Wallet: jest.fn().mockImplementation(() => ({
    loadMint: jest.fn(async () => {}),
  })),
  HttpResponseError: class HttpResponseError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
  MintOperationError: class MintOperationError extends Error {
    code: number;
    constructor(c: number, d: string) {
      super(d);
      this.code = c;
    }
  },
  JSONInt: JSON,
}));

type Result = { content: Array<{ text: string }>; isError?: boolean };
type Callback = (
  args: Record<string, unknown>,
  extra?: unknown
) => Promise<Result>;

function tool(name: string): Callback {
  const callbacks = new Map<string, Callback>();
  const server = {
    registerTool: jest.fn((n: string, _o: unknown, cb: Callback) =>
      callbacks.set(n, cb)
    ),
  };
  registerWriteTools(
    server as unknown as McpServer,
    {
      id: 1,
      pubkey: "b".repeat(64),
      permissions: "full_access",
    } as any
  );
  const cb = callbacks.get(name);
  if (!cb) throw new Error(`tool ${name} not registered`);
  return cb;
}

function payload(result: Result) {
  return JSON.parse(result.content[0]!.text);
}

describe("send_cashu_payment mintUrl SSRF guard", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ["loopback IPv4", "https://127.0.0.1:3338"],
    ["localhost", "https://localhost:3338"],
    ["private RFC1918", "https://10.0.0.5"],
    ["cloud metadata link-local", "https://169.254.169.254/latest"],
    ["non-https scheme", "http://mint.example.com"],
    ["not a URL", "not-a-url"],
  ])(
    "rejects %s mint URLs before the SDK is constructed",
    async (_label, mintUrl) => {
      const result = await tool("send_cashu_payment")({
        invoice: "lnbc10n1ptest",
        mintUrl,
      });
      expect(result.isError).toBe(true);
      expect(payload(result).error).toBe("Unsafe mint URL");
      // The SDK must never see the URL — its fetch resolves DNS itself, so
      // constructing the Mint would already be a network probe.
      expect(mintCtor).not.toHaveBeenCalled();
    }
  );

  it("constructs a public mint with the guarded customRequest transport", async () => {
    // A public IP literal passes isSafePublicHostname without any DNS lookup.
    const result = await tool("send_cashu_payment")({
      invoice: "lnbc10n1ptest",
      mintUrl: "https://1.1.1.1",
    });
    expect(mintCtor).toHaveBeenCalledTimes(1);
    const [url, opts] = mintCtor.mock.calls[0]!;
    expect(url).toBe("https://1.1.1.1");
    expect(typeof opts?.customRequest).toBe("function");
    // With no stored proofs the tool stops at the wallet check — the point
    // here is only that the guard let a public mint through, guarded.
    expect(payload(result).error).toBe("No available proofs");
  });
});
