/** @jest-environment node */

/**
 * Integration coverage for the scheduled-publish cron paired with the REAL
 * shared blog broadcast (`runBlogBroadcast`), driving each broadcast outcome
 * purely through the DB + SendGrid send layer (NOT by mocking the broadcast).
 *
 * The sibling `process-scheduled.test.ts` stubs `runBlogBroadcast` and only
 * checks the cron's consumption of canned outcomes. This file instead exercises
 * the cron through the same fail-closed gates the immediate "publish now"
 * endpoint hits — verified-sender-domain, unsubscribe-config, the once-per-
 * version idempotency claim, partial-failure counts — so a regression in how
 * the cron consumes the real broadcast can't slip a scheduled post into sending
 * twice or sending from an unverified domain.
 */

import handler from "@/pages/api/storefront/blog/process-scheduled";
import {
  claimDueScheduledBlogPosts,
  deletePublishedScheduledBlogPost,
  releaseScheduledBlogPostClaim,
  fetchBlogPostByDTagAndPubkey,
  fetchBlogPostsByPubkeyFromDb,
  getSellerAudienceEmails,
  claimBlogBroadcast,
  releaseBlogBroadcast,
  getShopSlugByPubkey,
} from "@/utils/db/db-service";
import { republishBlogPostToAuthorRelays } from "@/utils/nostr/server-nostr-helpers";
import { isPubkeyProEntitled } from "@/utils/pro/membership";
import { applyRateLimit } from "@/utils/rate-limit";
import { resolveSellerSenderEmail } from "@/utils/db/email-sender-domains";
import { loadStorefrontBranding } from "@/utils/email/storefront-branding";
import { sendEmailStrictFrom } from "@/utils/email/email-service";
import { buildBlogBroadcastEmail } from "@/utils/email/blog-broadcast-email";
import { buildSellerEmailUnsubscribeUrl } from "@/utils/email/unsubscribe-tokens";
import { getBlogPostSlug } from "@/utils/url-slugs";

// NOTE: `@/utils/email/blog-broadcast` is deliberately NOT mocked — the real
// broadcast runs and its outcomes are produced by the mocked layer below.
jest.mock("@/utils/db/db-service", () => ({
  // cron-owned
  claimDueScheduledBlogPosts: jest.fn(),
  deletePublishedScheduledBlogPost: jest.fn(),
  releaseScheduledBlogPostClaim: jest.fn(),
  // shared by cron + broadcast
  fetchBlogPostByDTagAndPubkey: jest.fn(),
  // broadcast-owned
  fetchBlogPostsByPubkeyFromDb: jest.fn(),
  getSellerAudienceEmails: jest.fn(),
  claimBlogBroadcast: jest.fn(),
  releaseBlogBroadcast: jest.fn(),
  getShopSlugByPubkey: jest.fn(),
}));
jest.mock("@/utils/nostr/server-nostr-helpers", () => ({
  republishBlogPostToAuthorRelays: jest.fn(),
}));
jest.mock("@/utils/pro/membership", () => ({
  isPubkeyProEntitled: jest.fn(),
}));
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));
jest.mock("@/utils/db/email-sender-domains", () => ({
  resolveSellerSenderEmail: jest.fn(),
}));
jest.mock("@/utils/email/storefront-branding", () => ({
  loadStorefrontBranding: jest.fn(),
}));
jest.mock("@/utils/email/email-service", () => ({
  sendEmailStrictFrom: jest.fn(),
}));
jest.mock("@/utils/email/blog-broadcast-email", () => ({
  buildBlogBroadcastEmail: jest.fn(() => ({
    subject: "New post",
    html: "<p>hi</p>",
  })),
}));
jest.mock("@/utils/email/unsubscribe-tokens", () => ({
  buildSellerEmailUnsubscribeUrl: jest.fn(),
}));
jest.mock("@/utils/url-slugs", () => ({
  getBlogPostSlug: jest.fn(() => "my-post"),
}));

const mocked = {
  claimDueScheduledBlogPosts: claimDueScheduledBlogPosts as jest.Mock,
  deletePublishedScheduledBlogPost:
    deletePublishedScheduledBlogPost as jest.Mock,
  releaseScheduledBlogPostClaim: releaseScheduledBlogPostClaim as jest.Mock,
  fetchBlogPostByDTagAndPubkey: fetchBlogPostByDTagAndPubkey as jest.Mock,
  fetchBlogPostsByPubkeyFromDb: fetchBlogPostsByPubkeyFromDb as jest.Mock,
  getSellerAudienceEmails: getSellerAudienceEmails as jest.Mock,
  claimBlogBroadcast: claimBlogBroadcast as jest.Mock,
  releaseBlogBroadcast: releaseBlogBroadcast as jest.Mock,
  getShopSlugByPubkey: getShopSlugByPubkey as jest.Mock,
  republishBlogPostToAuthorRelays: republishBlogPostToAuthorRelays as jest.Mock,
  isPubkeyProEntitled: isPubkeyProEntitled as jest.Mock,
  applyRateLimit: applyRateLimit as jest.Mock,
  resolveSellerSenderEmail: resolveSellerSenderEmail as jest.Mock,
  loadStorefrontBranding: loadStorefrontBranding as jest.Mock,
  sendEmailStrictFrom: sendEmailStrictFrom as jest.Mock,
  buildBlogBroadcastEmail: buildBlogBroadcastEmail as jest.Mock,
  buildSellerEmailUnsubscribeUrl: buildSellerEmailUnsubscribeUrl as jest.Mock,
  getBlogPostSlug: getBlogPostSlug as jest.Mock,
};

const SECRET = "test-flow-secret";
const PUBKEY = "a".repeat(64);
const D_TAG = "post-1";
const EVENT_ID = "evt-123";

// A kind:30023 event that `parseBlogPostEvent` (real, un-mocked) accepts: it
// needs both a `d` tag and a `title` tag to return a non-null post.
function blogEvent(id = EVENT_ID) {
  return {
    id,
    pubkey: PUBKEY,
    kind: 30023,
    created_at: 1000,
    content: "body",
    tags: [
      ["d", D_TAG],
      ["title", "Hello"],
      ["published_at", "900"],
    ],
  };
}

function dueRow(overrides: Record<string, unknown> = {}) {
  return {
    pubkey: PUBKEY,
    d_tag: D_TAG,
    event_id: EVENT_ID,
    signed_event: { id: EVENT_ID, kind: 30023, pubkey: PUBKEY },
    send_as_email: true,
    ...overrides,
  };
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

function run() {
  const req = {
    method: "POST",
    headers: { "x-flow-processor-secret": SECRET },
    body: {},
  } as any;
  const res = createMockResponse();
  return handler(req, res as any).then(() => res);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.FLOW_PROCESSOR_SECRET = SECRET;
  process.env.NEXT_PUBLIC_BASE_URL = "https://milk.market";

  mocked.applyRateLimit.mockReturnValue(true);

  // Cron happy-path: one due email-opted post, publishes + caches cleanly.
  mocked.claimDueScheduledBlogPosts.mockResolvedValue([dueRow()]);
  mocked.republishBlogPostToAuthorRelays.mockResolvedValue({ published: 3 });
  mocked.fetchBlogPostByDTagAndPubkey.mockResolvedValue(blogEvent());
  mocked.isPubkeyProEntitled.mockResolvedValue(true);
  mocked.deletePublishedScheduledBlogPost.mockResolvedValue(true);
  mocked.releaseScheduledBlogPostClaim.mockResolvedValue(true);

  // Broadcast happy-path layer.
  mocked.resolveSellerSenderEmail.mockResolvedValue("shop@verified.example");
  mocked.buildSellerEmailUnsubscribeUrl.mockImplementation(
    (base: string, _pk: string, to: string) =>
      `${base}/api/email/unsubscribe?token=${encodeURIComponent(to)}`
  );
  mocked.claimBlogBroadcast.mockResolvedValue(true);
  mocked.getSellerAudienceEmails.mockResolvedValue([
    "a@example.com",
    "b@example.com",
  ]);
  mocked.fetchBlogPostsByPubkeyFromDb.mockResolvedValue([blogEvent()]);
  mocked.getShopSlugByPubkey.mockResolvedValue("myshop");
  mocked.loadStorefrontBranding.mockResolvedValue({ shopName: "My Shop" });
  mocked.sendEmailStrictFrom.mockResolvedValue(true);
});

describe("process-scheduled cron × real runBlogBroadcast", () => {
  test("happy path: publishes, emails from the verified domain, drops the row", async () => {
    const res = await run();
    expect(res.statusCode).toBe(200);
    expect(res.body.processed).toBe(1);
    expect(res.body.results[0]).toMatchObject({
      status: "published",
      email: "sent",
    });
    // Real broadcast actually fanned out to the deduped audience.
    expect(mocked.sendEmailStrictFrom).toHaveBeenCalledTimes(2);
    for (const call of mocked.sendEmailStrictFrom.mock.calls) {
      expect(call[0].fromEmail).toBe("shop@verified.example");
      expect(call[0].headers["List-Unsubscribe"]).toContain("<https://");
    }
    expect(mocked.deletePublishedScheduledBlogPost).toHaveBeenCalledWith(
      PUBKEY,
      D_TAG,
      EVENT_ID
    );
    expect(mocked.releaseScheduledBlogPostClaim).not.toHaveBeenCalled();
  });

  test("FAIL-CLOSED: an unverified sender domain never sends, but the post still publishes", async () => {
    mocked.resolveSellerSenderEmail.mockResolvedValue(null);
    const res = await run();
    expect(res.body.results[0]).toMatchObject({
      status: "published",
      email: "skipped",
    });
    expect(mocked.sendEmailStrictFrom).not.toHaveBeenCalled();
    // The one-shot ledger must NOT be burned by a skip.
    expect(mocked.claimBlogBroadcast).not.toHaveBeenCalled();
    expect(mocked.deletePublishedScheduledBlogPost).toHaveBeenCalled();
  });

  test("skips (no double-send risk) when unsubscribe links can't be minted", async () => {
    mocked.buildSellerEmailUnsubscribeUrl.mockImplementation(() => {
      throw new Error("no secret");
    });
    const res = await run();
    expect(res.body.results[0]).toMatchObject({
      status: "published",
      email: "skipped",
    });
    expect(mocked.sendEmailStrictFrom).not.toHaveBeenCalled();
    expect(mocked.claimBlogBroadcast).not.toHaveBeenCalled();
    expect(mocked.deletePublishedScheduledBlogPost).toHaveBeenCalled();
  });

  test("empty audience finalizes the post without burning the one-shot claim", async () => {
    mocked.getSellerAudienceEmails.mockResolvedValue([]);
    const res = await run();
    expect(res.body.results[0]).toMatchObject({
      status: "published",
      email: "empty-audience",
    });
    expect(mocked.sendEmailStrictFrom).not.toHaveBeenCalled();
    // Claim is taken only AFTER a non-empty audience is confirmed.
    expect(mocked.claimBlogBroadcast).not.toHaveBeenCalled();
    expect(mocked.deletePublishedScheduledBlogPost).toHaveBeenCalled();
  });

  test("partial failure: counts per-recipient sends, keeps the claim, finalizes the post", async () => {
    mocked.getSellerAudienceEmails.mockResolvedValue([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    mocked.sendEmailStrictFrom
      .mockRejectedValueOnce(new Error("smtp blew up"))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const res = await run();
    // Something went out → terminal "sent" outcome → post finalized, claim kept.
    expect(res.body.results[0]).toMatchObject({
      status: "published",
      email: "sent",
    });
    expect(mocked.sendEmailStrictFrom).toHaveBeenCalledTimes(3);
    expect(mocked.releaseBlogBroadcast).not.toHaveBeenCalled();
    expect(mocked.deletePublishedScheduledBlogPost).toHaveBeenCalled();
  });

  test("all-failed: releases the broadcast claim AND keeps the scheduled row for retry", async () => {
    mocked.sendEmailStrictFrom.mockResolvedValue(false);
    const res = await run();
    expect(res.body.processed).toBe(0);
    expect(res.body.results[0]).toMatchObject({
      status: "retry",
      email: "all-failed",
    });
    // Broadcast releases its own one-shot claim so the version can resend...
    expect(mocked.releaseBlogBroadcast).toHaveBeenCalledWith(
      PUBKEY,
      D_TAG,
      EVENT_ID
    );
    // ...and the cron keeps the scheduled row (no delete) for the next tick.
    expect(mocked.releaseScheduledBlogPostClaim).toHaveBeenCalled();
    expect(mocked.deletePublishedScheduledBlogPost).not.toHaveBeenCalled();
  });

  test("a post already broadcast is NOT re-sent on a second cron run", async () => {
    // Stateful one-shot ledger: the first claim wins, every later claim loses.
    let claimed = false;
    mocked.claimBlogBroadcast.mockImplementation(async () => {
      if (claimed) return false; // already-sent
      claimed = true;
      return true;
    });

    const first = await run();
    expect(first.body.results[0]).toMatchObject({
      status: "published",
      email: "sent",
    });
    expect(mocked.sendEmailStrictFrom).toHaveBeenCalledTimes(2);

    // A second tick re-claims the same due row (e.g. the delete hadn't landed,
    // or a duplicate schedule). The real broadcast must short-circuit on the
    // ledger and emit ZERO additional emails.
    mocked.sendEmailStrictFrom.mockClear();
    const second = await run();
    expect(second.body.results[0]).toMatchObject({
      status: "published",
      email: "skipped",
    });
    expect(mocked.sendEmailStrictFrom).not.toHaveBeenCalled();
  });

  test("a no-longer-Pro seller publishes but the broadcast never runs", async () => {
    mocked.isPubkeyProEntitled.mockResolvedValue(false);
    const res = await run();
    expect(res.body.results[0]).toMatchObject({
      status: "published",
      email: "not-pro",
    });
    expect(mocked.resolveSellerSenderEmail).not.toHaveBeenCalled();
    expect(mocked.sendEmailStrictFrom).not.toHaveBeenCalled();
    expect(mocked.deletePublishedScheduledBlogPost).toHaveBeenCalled();
  });
});
