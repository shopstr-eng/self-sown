/** @jest-environment node */

import handler from "@/pages/api/storefront/blog/scheduled-post";
import {
  upsertScheduledBlogPost,
  deleteScheduledBlogPost,
} from "@/utils/db/db-service";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { applyRateLimit } from "@/utils/rate-limit";
import { verifyEvent } from "nostr-tools";
import { parseBlogPostEvent } from "@milk-market/domain";

jest.mock("@/utils/db/db-service", () => ({
  upsertScheduledBlogPost: jest.fn(),
  deleteScheduledBlogPost: jest.fn(),
}));
jest.mock("@/utils/stripe/verify-nostr-auth", () => ({
  verifyNostrAuth: jest.fn(),
}));
jest.mock("@/utils/pro/require-pro", () => ({
  requireProEntitlement: jest.fn(),
}));
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));
jest.mock("nostr-tools", () => ({
  verifyEvent: jest.fn(() => true),
}));
jest.mock("@milk-market/domain", () => ({
  parseBlogPostEvent: jest.fn(),
}));

const mocked = {
  upsertScheduledBlogPost: upsertScheduledBlogPost as jest.Mock,
  deleteScheduledBlogPost: deleteScheduledBlogPost as jest.Mock,
  verifyNostrAuth: verifyNostrAuth as jest.Mock,
  requireProEntitlement: requireProEntitlement as jest.Mock,
  applyRateLimit: applyRateLimit as jest.Mock,
  verifyEvent: verifyEvent as unknown as jest.Mock,
  parseBlogPostEvent: parseBlogPostEvent as jest.Mock,
};

const PUBKEY = "a".repeat(64);
const D_TAG = "post-1";
const EVENT_ID = "evt-123";

function blogEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    pubkey: PUBKEY,
    kind: 30023,
    created_at: 1000,
    content: "body",
    sig: "s".repeat(128),
    tags: [
      ["d", D_TAG],
      ["title", "Hello"],
    ],
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

function run(method: string, body: unknown) {
  const req = { method, body } as any;
  const res = createMockResponse();
  return handler(req, res as any).then(() => res);
}

beforeEach(() => {
  jest.clearAllMocks();
  mocked.applyRateLimit.mockReturnValue(true);
  mocked.verifyNostrAuth.mockReturnValue({ valid: true, pubkey: PUBKEY });
  mocked.requireProEntitlement.mockResolvedValue(true);
  mocked.verifyEvent.mockReturnValue(true);
  mocked.parseBlogPostEvent.mockReturnValue({
    dTag: D_TAG,
    title: "Hello",
    summary: "",
    content: "body",
    image: "",
    externalUrl: "",
    hashtags: [],
    publishedAt: 900,
    id: EVENT_ID,
    pubkey: PUBKEY,
  });
  mocked.upsertScheduledBlogPost.mockResolvedValue(true);
  mocked.deleteScheduledBlogPost.mockResolvedValue(true);
});

describe("scheduled-post endpoint", () => {
  test("rejects unsupported methods", async () => {
    const res = await run("GET", {});
    expect(res.statusCode).toBe(405);
  });

  test("requires pubkey", async () => {
    const res = await run("POST", { blogEvent: blogEvent() });
    expect(res.statusCode).toBe(400);
  });

  test("rejects a non-30023 blogEvent", async () => {
    const res = await run("POST", {
      pubkey: PUBKEY,
      signedEvent: {},
      blogEvent: blogEvent({ kind: 1 }),
    });
    expect(res.statusCode).toBe(400);
    expect(mocked.upsertScheduledBlogPost).not.toHaveBeenCalled();
  });

  test("rejects a blogEvent whose pubkey doesn't match", async () => {
    const res = await run("POST", {
      pubkey: PUBKEY,
      signedEvent: {},
      blogEvent: blogEvent({ pubkey: "b".repeat(64) }),
    });
    expect(res.statusCode).toBe(400);
  });

  test("rejects an invalid signature", async () => {
    mocked.verifyEvent.mockReturnValue(false);
    const res = await run("POST", {
      pubkey: PUBKEY,
      signedEvent: {},
      blogEvent: blogEvent(),
    });
    expect(res.statusCode).toBe(400);
    expect(mocked.upsertScheduledBlogPost).not.toHaveBeenCalled();
  });

  test("rejects a scheduledAt in the past before checking auth or Pro", async () => {
    const res = await run("POST", {
      pubkey: PUBKEY,
      signedEvent: {},
      blogEvent: blogEvent(),
      scheduledAt: Math.floor(Date.now() / 1000) - 100,
    });
    expect(res.statusCode).toBe(400);
    expect(mocked.verifyNostrAuth).not.toHaveBeenCalled();
    expect(mocked.requireProEntitlement).not.toHaveBeenCalled();
  });

  test("returns 401 on invalid auth and never checks Pro", async () => {
    mocked.verifyNostrAuth.mockReturnValue({ valid: false, error: "bad" });
    const res = await run("POST", {
      pubkey: PUBKEY,
      signedEvent: {},
      blogEvent: blogEvent(),
    });
    expect(res.statusCode).toBe(401);
    expect(mocked.requireProEntitlement).not.toHaveBeenCalled();
    expect(mocked.upsertScheduledBlogPost).not.toHaveBeenCalled();
  });

  test("is Pro-gated: a non-Pro seller can't save", async () => {
    mocked.requireProEntitlement.mockImplementation(
      async (_pk: string, res: any) => {
        res.status(403).json({ error: "pro required" });
        return false;
      }
    );
    const res = await run("POST", {
      pubkey: PUBKEY,
      signedEvent: {},
      blogEvent: blogEvent(),
    });
    expect(res.statusCode).toBe(403);
    expect(mocked.upsertScheduledBlogPost).not.toHaveBeenCalled();
  });

  test("saves a draft (no scheduledAt) with status=draft", async () => {
    const res = await run("POST", {
      pubkey: PUBKEY,
      signedEvent: {},
      blogEvent: blogEvent(),
      sendAsEmail: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "draft", dTag: D_TAG });
    const arg = mocked.upsertScheduledBlogPost.mock.calls[0][0];
    expect(arg).toMatchObject({
      status: "draft",
      scheduledAt: null,
      sendAsEmail: true,
      eventId: EVENT_ID,
    });
  });

  test("saves a scheduled post with the future epoch", async () => {
    const when = Math.floor(Date.now() / 1000) + 3600;
    const res = await run("POST", {
      pubkey: PUBKEY,
      signedEvent: {},
      blogEvent: blogEvent(),
      scheduledAt: when,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ status: "scheduled" });
    const arg = mocked.upsertScheduledBlogPost.mock.calls[0][0];
    expect(arg).toMatchObject({ status: "scheduled", scheduledAt: when });
  });

  test("DELETE requires a dTag", async () => {
    const res = await run("DELETE", { pubkey: PUBKEY, signedEvent: {} });
    expect(res.statusCode).toBe(400);
  });

  test("DELETE removes the row when authed", async () => {
    const res = await run("DELETE", {
      pubkey: PUBKEY,
      signedEvent: {},
      dTag: D_TAG,
    });
    expect(res.statusCode).toBe(200);
    expect(mocked.deleteScheduledBlogPost).toHaveBeenCalledWith(PUBKEY, D_TAG);
  });
});
