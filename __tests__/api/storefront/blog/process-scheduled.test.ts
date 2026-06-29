/** @jest-environment node */

import handler from "@/pages/api/storefront/blog/process-scheduled";
import {
  claimDueScheduledBlogPosts,
  deletePublishedScheduledBlogPost,
  releaseScheduledBlogPostClaim,
  fetchBlogPostByDTagAndPubkey,
} from "@/utils/db/db-service";
import { republishBlogPostToAuthorRelays } from "@/utils/nostr/server-nostr-helpers";
import { runBlogBroadcast } from "@/utils/email/blog-broadcast";
import { isPubkeyProEntitled } from "@/utils/pro/membership";
import { applyRateLimit } from "@/utils/rate-limit";

jest.mock("@/utils/db/db-service", () => ({
  claimDueScheduledBlogPosts: jest.fn(),
  deletePublishedScheduledBlogPost: jest.fn(),
  releaseScheduledBlogPostClaim: jest.fn(),
  fetchBlogPostByDTagAndPubkey: jest.fn(),
}));
jest.mock("@/utils/nostr/server-nostr-helpers", () => ({
  republishBlogPostToAuthorRelays: jest.fn(),
}));
jest.mock("@/utils/email/blog-broadcast", () => ({
  runBlogBroadcast: jest.fn(),
}));
jest.mock("@/utils/pro/membership", () => ({
  isPubkeyProEntitled: jest.fn(),
}));
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));

const mocked = {
  claimDueScheduledBlogPosts: claimDueScheduledBlogPosts as jest.Mock,
  deletePublishedScheduledBlogPost:
    deletePublishedScheduledBlogPost as jest.Mock,
  releaseScheduledBlogPostClaim: releaseScheduledBlogPostClaim as jest.Mock,
  fetchBlogPostByDTagAndPubkey: fetchBlogPostByDTagAndPubkey as jest.Mock,
  republishBlogPostToAuthorRelays: republishBlogPostToAuthorRelays as jest.Mock,
  runBlogBroadcast: runBlogBroadcast as jest.Mock,
  isPubkeyProEntitled: isPubkeyProEntitled as jest.Mock,
  applyRateLimit: applyRateLimit as jest.Mock,
};

const SECRET = "test-flow-secret";
const PUBKEY = "a".repeat(64);
const D_TAG = "post-1";
const EVENT_ID = "evt-123";

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    pubkey: PUBKEY,
    d_tag: D_TAG,
    event_id: EVENT_ID,
    signed_event: { id: EVENT_ID, kind: 30023, pubkey: PUBKEY },
    send_as_email: false,
    ...overrides,
  };
}

function cachedPost(id = EVENT_ID) {
  return { id, pubkey: PUBKEY, kind: 30023, tags: [["d", D_TAG]] };
}

function createMockResponse() {
  const response = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(payload: unknown) {
      response.body = payload;
      return response;
    },
  };
  return response;
}

function run(opts: { method?: string; secret?: string; body?: any } = {}) {
  const req = {
    method: opts.method ?? "POST",
    headers: opts.secret ? { "x-flow-processor-secret": opts.secret } : {},
    body: opts.body ?? {},
  } as any;
  const res = createMockResponse();
  return handler(req, res as any).then(() => res);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.FLOW_PROCESSOR_SECRET = SECRET;
  mocked.applyRateLimit.mockReturnValue(true);
  mocked.claimDueScheduledBlogPosts.mockResolvedValue([]);
  mocked.republishBlogPostToAuthorRelays.mockResolvedValue({ published: 3 });
  mocked.fetchBlogPostByDTagAndPubkey.mockResolvedValue(cachedPost());
  mocked.isPubkeyProEntitled.mockResolvedValue(true);
  mocked.runBlogBroadcast.mockResolvedValue({ kind: "sent", sent: 2 });
  mocked.deletePublishedScheduledBlogPost.mockResolvedValue(true);
  mocked.releaseScheduledBlogPostClaim.mockResolvedValue(true);
});

describe("process-scheduled cron", () => {
  test("rejects non-POST", async () => {
    const res = await run({ method: "GET", secret: SECRET });
    expect(res.statusCode).toBe(405);
  });

  test("rejects a wrong secret", async () => {
    const res = await run({ secret: "nope" });
    expect(res.statusCode).toBe(401);
    expect(mocked.claimDueScheduledBlogPosts).not.toHaveBeenCalled();
  });

  test("returns processed:0 when nothing is due", async () => {
    const res = await run({ secret: SECRET });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ processed: 0, results: [] });
  });

  test("publishes a due post (no email) and drops the row", async () => {
    mocked.claimDueScheduledBlogPosts.mockResolvedValue([dueRow()]);
    const res = await run({ secret: SECRET });
    expect(res.statusCode).toBe(200);
    expect(res.body.processed).toBe(1);
    expect(res.body.results[0]).toMatchObject({ status: "published" });
    expect(mocked.runBlogBroadcast).not.toHaveBeenCalled();
    expect(mocked.deletePublishedScheduledBlogPost).toHaveBeenCalledWith(
      PUBKEY,
      D_TAG,
      EVENT_ID
    );
  });

  test("publishes + emails when opted-in and Pro", async () => {
    mocked.claimDueScheduledBlogPosts.mockResolvedValue([
      dueRow({ send_as_email: true }),
    ]);
    const res = await run({ secret: SECRET });
    expect(res.body.results[0]).toMatchObject({
      status: "published",
      email: "sent",
    });
    expect(mocked.runBlogBroadcast).toHaveBeenCalledWith({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
    });
    expect(mocked.deletePublishedScheduledBlogPost).toHaveBeenCalled();
  });

  test("skips email for a no-longer-Pro seller but still publishes", async () => {
    mocked.isPubkeyProEntitled.mockResolvedValue(false);
    mocked.claimDueScheduledBlogPosts.mockResolvedValue([
      dueRow({ send_as_email: true }),
    ]);
    const res = await run({ secret: SECRET });
    expect(res.body.results[0]).toMatchObject({
      status: "published",
      email: "not-pro",
    });
    expect(mocked.runBlogBroadcast).not.toHaveBeenCalled();
    expect(mocked.deletePublishedScheduledBlogPost).toHaveBeenCalled();
  });

  test("retries (keeps the row) when the post isn't cached after publish", async () => {
    mocked.fetchBlogPostByDTagAndPubkey.mockResolvedValue(null);
    mocked.claimDueScheduledBlogPosts.mockResolvedValue([dueRow()]);
    const res = await run({ secret: SECRET });
    expect(res.body.processed).toBe(0);
    expect(res.body.results[0]).toMatchObject({ status: "retry" });
    expect(mocked.releaseScheduledBlogPostClaim).toHaveBeenCalledWith(
      PUBKEY,
      D_TAG,
      EVENT_ID,
      expect.objectContaining({
        error: expect.any(String),
        at: expect.any(Number),
      })
    );
    expect(mocked.deletePublishedScheduledBlogPost).not.toHaveBeenCalled();
  });

  test("retries on a transient email failure but leaves the post live", async () => {
    mocked.runBlogBroadcast.mockResolvedValue({ kind: "all-failed" });
    mocked.claimDueScheduledBlogPosts.mockResolvedValue([
      dueRow({ send_as_email: true }),
    ]);
    const res = await run({ secret: SECRET });
    expect(res.body.results[0]).toMatchObject({
      status: "retry",
      email: "all-failed",
    });
    expect(mocked.releaseScheduledBlogPostClaim).toHaveBeenCalled();
    expect(mocked.deletePublishedScheduledBlogPost).not.toHaveBeenCalled();
  });

  test("a terminal email outcome (empty-audience) still finalizes the post", async () => {
    mocked.runBlogBroadcast.mockResolvedValue({ kind: "empty-audience" });
    mocked.claimDueScheduledBlogPosts.mockResolvedValue([
      dueRow({ send_as_email: true }),
    ]);
    const res = await run({ secret: SECRET });
    expect(res.body.results[0]).toMatchObject({
      status: "published",
      email: "empty-audience",
    });
    expect(mocked.deletePublishedScheduledBlogPost).toHaveBeenCalled();
  });

  test("releases the claim and reports error when publishing throws", async () => {
    mocked.republishBlogPostToAuthorRelays.mockRejectedValue(
      new Error("relay down")
    );
    mocked.claimDueScheduledBlogPosts.mockResolvedValue([dueRow()]);
    const res = await run({ secret: SECRET });
    expect(res.body.results[0]).toMatchObject({ status: "error" });
    expect(mocked.releaseScheduledBlogPostClaim).toHaveBeenCalled();
    expect(mocked.deletePublishedScheduledBlogPost).not.toHaveBeenCalled();
  });
});
