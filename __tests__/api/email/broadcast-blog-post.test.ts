/** @jest-environment node */

import handler from "@/pages/api/email/broadcast-blog-post";
import {
  fetchBlogPostByDTagAndPubkey,
  fetchBlogPostsByPubkeyFromDb,
  getSellerAudienceEmails,
  claimBlogBroadcast,
  releaseBlogBroadcast,
  getShopSlugByPubkey,
} from "@/utils/db/db-service";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { resolveSellerSenderEmail } from "@/utils/db/email-sender-domains";
import { loadStorefrontBranding } from "@/utils/email/storefront-branding";
import { sendEmailStrictFrom } from "@/utils/email/email-service";
import { buildBlogBroadcastEmail } from "@/utils/email/blog-broadcast-email";
import { buildSellerEmailUnsubscribeUrl } from "@/utils/email/unsubscribe-tokens";
import { applyRateLimit } from "@/utils/rate-limit";
import { getBlogPostSlug } from "@/utils/url-slugs";

jest.mock("@/utils/db/db-service", () => ({
  fetchBlogPostByDTagAndPubkey: jest.fn(),
  fetchBlogPostsByPubkeyFromDb: jest.fn(),
  getSellerAudienceEmails: jest.fn(),
  claimBlogBroadcast: jest.fn(),
  releaseBlogBroadcast: jest.fn(),
  getShopSlugByPubkey: jest.fn(),
}));
jest.mock("@/utils/stripe/verify-nostr-auth", () => ({
  verifyNostrAuth: jest.fn(),
}));
jest.mock("@/utils/pro/require-pro", () => ({
  requireProEntitlement: jest.fn(),
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
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));
jest.mock("@/utils/url-slugs", () => ({
  getBlogPostSlug: jest.fn(() => "my-post"),
}));

const mocked = {
  fetchBlogPostByDTagAndPubkey: fetchBlogPostByDTagAndPubkey as jest.Mock,
  fetchBlogPostsByPubkeyFromDb: fetchBlogPostsByPubkeyFromDb as jest.Mock,
  getSellerAudienceEmails: getSellerAudienceEmails as jest.Mock,
  claimBlogBroadcast: claimBlogBroadcast as jest.Mock,
  releaseBlogBroadcast: releaseBlogBroadcast as jest.Mock,
  getShopSlugByPubkey: getShopSlugByPubkey as jest.Mock,
  verifyNostrAuth: verifyNostrAuth as jest.Mock,
  requireProEntitlement: requireProEntitlement as jest.Mock,
  resolveSellerSenderEmail: resolveSellerSenderEmail as jest.Mock,
  loadStorefrontBranding: loadStorefrontBranding as jest.Mock,
  sendEmailStrictFrom: sendEmailStrictFrom as jest.Mock,
  buildBlogBroadcastEmail: buildBlogBroadcastEmail as jest.Mock,
  buildSellerEmailUnsubscribeUrl: buildSellerEmailUnsubscribeUrl as jest.Mock,
  applyRateLimit: applyRateLimit as jest.Mock,
  getBlogPostSlug: getBlogPostSlug as jest.Mock,
};

const PUBKEY = "a".repeat(64);
const D_TAG = "post-1";
const EVENT_ID = "evt-123";

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

function run(body: unknown) {
  const req = { method: "POST", body } as any;
  const res = createMockResponse();
  return handler(req, res as any).then(() => res);
}

beforeEach(() => {
  jest.clearAllMocks();
  // Happy-path defaults; individual tests override as needed.
  mocked.applyRateLimit.mockReturnValue(true);
  mocked.verifyNostrAuth.mockReturnValue({ valid: true, pubkey: PUBKEY });
  mocked.requireProEntitlement.mockResolvedValue(true);
  mocked.fetchBlogPostByDTagAndPubkey.mockResolvedValue(blogEvent());
  mocked.resolveSellerSenderEmail.mockResolvedValue("shop@verified.example");
  mocked.buildSellerEmailUnsubscribeUrl.mockReturnValue(
    "https://milk.market/api/email/unsubscribe?token=x"
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

describe("broadcast-blog-post endpoint", () => {
  test("rejects non-POST", async () => {
    const req = { method: "GET", body: {} } as any;
    const res = createMockResponse();
    await handler(req, res as any);
    expect(res.statusCode).toBe(405);
  });

  test("validates required fields", async () => {
    const res = await run({ dTag: D_TAG, eventId: EVENT_ID });
    expect(res.statusCode).toBe(400);
  });

  test("returns 401 when auth is invalid (never checks Pro)", async () => {
    mocked.verifyNostrAuth.mockReturnValue({ valid: false, error: "bad" });
    const res = await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent: {},
    });
    expect(res.statusCode).toBe(401);
    expect(mocked.requireProEntitlement).not.toHaveBeenCalled();
  });

  test("binds auth to blog-broadcast-write AND this exact (dTag, eventId)", async () => {
    const signedEvent = { sig: "sig" };
    await run({ pubkey: PUBKEY, dTag: D_TAG, eventId: EVENT_ID, signedEvent });
    // The captured auth event must be bound to the action AND the specific
    // published version, so it can't be replayed against a different post.
    expect(mocked.verifyNostrAuth).toHaveBeenCalledWith(
      signedEvent,
      PUBKEY,
      "blog-broadcast-write",
      expect.objectContaining({
        method: "POST",
        path: "/api/email/broadcast-blog-post",
        fields: { dTag: D_TAG, eventId: EVENT_ID },
      })
    );
  });

  test("rejects an unknown audienceSource without touching auth", async () => {
    const res = await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent: {},
      audienceSource: "everyone",
    });
    expect(res.statusCode).toBe(400);
    expect(mocked.verifyNostrAuth).not.toHaveBeenCalled();
  });

  test("binds a chosen audienceSource into auth and forwards it to the resolver", async () => {
    const signedEvent = { sig: "sig" };
    await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent,
      audienceSource: "subscription",
    });
    // The segment is part of the bound auth fields so it can't be retargeted.
    expect(mocked.verifyNostrAuth).toHaveBeenCalledWith(
      signedEvent,
      PUBKEY,
      "blog-broadcast-write",
      expect.objectContaining({
        fields: {
          dTag: D_TAG,
          eventId: EVENT_ID,
          audienceSource: "subscription",
        },
      })
    );
    // And the resolver must be scoped to that same source.
    expect(mocked.getSellerAudienceEmails).toHaveBeenCalledWith(
      PUBKEY,
      "subscription"
    );
  });

  test("a full-audience send (no source) leaves auth + resolver unscoped", async () => {
    await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent: { sig: "sig" },
    });
    expect(mocked.verifyNostrAuth).toHaveBeenCalledWith(
      expect.anything(),
      PUBKEY,
      "blog-broadcast-write",
      expect.objectContaining({ fields: { dTag: D_TAG, eventId: EVENT_ID } })
    );
    expect(mocked.getSellerAudienceEmails).toHaveBeenCalledWith(
      PUBKEY,
      undefined
    );
  });

  test("returns 403 when the seller lacks Pro entitlement (never sends)", async () => {
    // requireProEntitlement writes the 403 itself and returns false; the handler
    // must short-circuit before claiming or sending anything.
    mocked.requireProEntitlement.mockImplementation(async (_pk, res: any) => {
      res.status(403).json({ error: "Pro required" });
      return false;
    });
    const res = await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent: {},
    });
    expect(res.statusCode).toBe(403);
    expect(mocked.claimBlogBroadcast).not.toHaveBeenCalled();
    expect(mocked.sendEmailStrictFrom).not.toHaveBeenCalled();
  });

  test("returns 409 retryable when the post version isn't cached yet", async () => {
    mocked.fetchBlogPostByDTagAndPubkey.mockResolvedValue(null);
    const res = await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.body.retryable).toBe(true);
    expect(mocked.claimBlogBroadcast).not.toHaveBeenCalled();
  });

  test("returns 409 when the cached id doesn't match the requested version", async () => {
    mocked.fetchBlogPostByDTagAndPubkey.mockResolvedValue(
      blogEvent("different-id")
    );
    const res = await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent: {},
    });
    expect(res.statusCode).toBe(409);
    expect(mocked.sendEmailStrictFrom).not.toHaveBeenCalled();
  });

  test("FAIL-CLOSED: skips without a verified sender domain and never claims or sends", async () => {
    mocked.resolveSellerSenderEmail.mockResolvedValue(null);
    const res = await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      skipped: true,
      reason: "no-verified-sender-domain",
      sent: 0,
    });
    expect(mocked.claimBlogBroadcast).not.toHaveBeenCalled();
    expect(mocked.sendEmailStrictFrom).not.toHaveBeenCalled();
  });

  test("skips when unsubscribe links can't be minted", async () => {
    mocked.buildSellerEmailUnsubscribeUrl.mockImplementation(() => {
      throw new Error("no secret");
    });
    const res = await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.reason).toBe("unsubscribe-unavailable");
    expect(mocked.claimBlogBroadcast).not.toHaveBeenCalled();
  });

  test("is idempotent: a second claim returns already-sent without sending", async () => {
    mocked.claimBlogBroadcast.mockResolvedValue(false);
    const res = await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.reason).toBe("already-sent");
    expect(mocked.sendEmailStrictFrom).not.toHaveBeenCalled();
  });

  test("empty-audience never burns the one-shot claim (so it stays retryable)", async () => {
    mocked.getSellerAudienceEmails.mockResolvedValue([]);
    const res = await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ total: 0, reason: "empty-audience" });
    expect(mocked.sendEmailStrictFrom).not.toHaveBeenCalled();
    // Critical: the idempotency ledger must NOT be claimed when there's no one
    // to email, or this published version can never be broadcast later.
    expect(mocked.claimBlogBroadcast).not.toHaveBeenCalled();
  });

  test("happy path sends from the verified domain to the deduped audience", async () => {
    mocked.getSellerAudienceEmails.mockResolvedValue([
      "a@example.com",
      "A@example.com",
      "b@example.com",
    ]);
    const res = await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ sent: 2, failed: 0, skipped: false });
    expect(mocked.sendEmailStrictFrom).toHaveBeenCalledTimes(2);
    for (const call of mocked.sendEmailStrictFrom.mock.calls) {
      expect(call[0].fromEmail).toBe("shop@verified.example");
      expect(call[0].headers["List-Unsubscribe"]).toContain("<https://");
    }
  });

  test("partial failure: reports per-recipient sent/failed counts and keeps the claim", async () => {
    mocked.getSellerAudienceEmails.mockResolvedValue([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    // One recipient hard-throws, one is rejected by SendGrid, one succeeds.
    mocked.sendEmailStrictFrom
      .mockRejectedValueOnce(new Error("smtp blew up"))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const res = await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent: {},
    });
    // As long as SOMETHING went out, it's a 200 success with accurate counts and
    // the one-shot claim is retained (the version is considered broadcast).
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      sent: 1,
      failed: 2,
      total: 3,
      skipped: false,
    });
    expect(mocked.releaseBlogBroadcast).not.toHaveBeenCalled();
  });

  test("returns 503 retryable when the broadcast claim can't be recorded", async () => {
    mocked.claimBlogBroadcast.mockResolvedValue(null);
    const res = await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.body.retryable).toBe(true);
    expect(mocked.sendEmailStrictFrom).not.toHaveBeenCalled();
  });

  test("releases the claim and returns 502 when every send fails", async () => {
    mocked.sendEmailStrictFrom.mockResolvedValue(false);
    const res = await run({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      signedEvent: {},
    });
    expect(res.statusCode).toBe(502);
    expect(mocked.releaseBlogBroadcast).toHaveBeenCalledWith(
      PUBKEY,
      D_TAG,
      EVENT_ID
    );
  });
});
