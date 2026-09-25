/** @jest-environment node */

/**
 * Contract tests for the SendGrid Event Webhook receiver
 * (pages/api/email/sendgrid-events.ts):
 *
 *  - Requests are accepted ONLY with a valid Ed25519 signature over
 *    timestamp+rawBody (SendGrid's signed event webhook scheme); a missing
 *    verification key or bad signature is a 401 — a forged "bounce" batch
 *    would let anyone silently wipe a seller's email audience.
 *  - A bounce/dropped/spamreport event carrying the seller_pubkey custom arg
 *    (stamped by the broadcast senders) lands the address on that seller's
 *    suppression list, and a LATER broadcast audience skips it — this is the
 *    gap the endpoint exists to close: SendGrid accepted the send, so the
 *    synchronous 4xx suppression path never saw the dead address.
 *  - Non-suppressing events (delivered/open) and events without seller
 *    attribution are ignored; per-event write failures never fail the batch
 *    (the cron suppression sync is the backstop, and a non-2xx would make
 *    SendGrid re-post the whole batch).
 */

import crypto from "crypto";
import { EventEmitter } from "events";

// In-memory email_unsubscribes stand-in: "sellerPubkey|email" -> reason.
const unsubscribes = new Map<string, string>();

const mockUnsubscribeSellerEmail: jest.Mock = jest.fn(
  async (pubkey: string, email: string, reason: string) => {
    const key = `${pubkey}|${email.trim().toLowerCase()}`;
    if (!unsubscribes.has(key)) unsubscribes.set(key, reason);
    return true;
  }
);
const mockGetSellerAudienceEmails: jest.Mock = jest.fn(
  async (pubkey: string) => {
    const all = ["alive@example.com", "dead@example.com"];
    return all.filter((e) => !unsubscribes.has(`${pubkey}|${e}`));
  }
);
const mockClaimWithCap: jest.Mock = jest.fn(async () => "claimed");
const mockGetRecipients: jest.Mock = jest.fn(async () => []);
const mockClaimRecipient: jest.Mock = jest.fn(async () => true);
const mockReleaseRecipient: jest.Mock = jest.fn(async () => true);
const mockReleaseBroadcast: jest.Mock = jest.fn(async () => true);

jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
  unsubscribeSellerEmail: (...args: unknown[]) =>
    mockUnsubscribeSellerEmail(...args),
  getSellerAudienceEmails: (...args: unknown[]) =>
    mockGetSellerAudienceEmails(...args),
  claimOneTimeBroadcastWithCap: (...args: unknown[]) =>
    mockClaimWithCap(...args),
  releaseOneTimeBroadcast: (...args: unknown[]) =>
    mockReleaseBroadcast(...args),
  getOneTimeBroadcastRecipients: (...args: unknown[]) =>
    mockGetRecipients(...args),
  claimOneTimeBroadcastRecipient: (...args: unknown[]) =>
    mockClaimRecipient(...args),
  releaseOneTimeBroadcastRecipient: (...args: unknown[]) =>
    mockReleaseRecipient(...args),
  isSellerEmailUnsubscribedStrict: jest.fn(async () => false),
}));

jest.mock("@/utils/db/email-sender-domains", () => ({
  resolveSellerSenderEmail: jest.fn(async () => "seller@shop.test"),
}));
jest.mock("@/utils/email/storefront-branding", () => ({
  loadStorefrontBranding: jest.fn(async () => null),
}));
jest.mock("@/utils/email/unsubscribe-tokens", () => ({
  buildSellerEmailUnsubscribeUrl: jest.fn(() => "https://x.test/unsub?t=1"),
}));
jest.mock("@/utils/site-url", () => ({ getSiteUrl: () => "https://x.test" }));
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));

const mockSendDetailed: jest.Mock = jest.fn(async () => ({
  ok: true,
  definiteReject: false,
  recipientReject: false,
}));
jest.mock("@/utils/email/email-service", () => ({
  sendEmail: jest.fn(async () => true),
  sendEmailStrictFromDetailed: (...args: unknown[]) =>
    mockSendDetailed(...args),
}));

import handler from "@/pages/api/email/sendgrid-events";
import { runOneTimeBroadcast } from "@/utils/email/one-time-broadcast";

const PUBKEY = "a".repeat(64);

// A real Ed25519 keypair stands in for SendGrid's signing key; the route is
// configured with the raw-base64 public key exactly as SendGrid's
// "verification key" is formatted.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUBLIC_KEY_B64 = (publicKey.export({ format: "der", type: "spki" }) as Buffer)
  .subarray(-32)
  .toString("base64");

function signRequest(body: string): { signature: string; timestamp: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .sign(null, Buffer.from(timestamp + body, "utf8"), privateKey)
    .toString("base64");
  return { signature, timestamp };
}

function mockReqRes(opts: {
  body: string;
  signature?: string;
  timestamp?: string;
}) {
  const req: any = new EventEmitter();
  req.method = "POST";
  req.headers = {};
  if (opts.signature) {
    req.headers["x-twilio-email-event-webhook-signature"] = opts.signature;
  }
  if (opts.timestamp) {
    req.headers["x-twilio-email-event-webhook-timestamp"] = opts.timestamp;
  }
  process.nextTick(() => {
    req.emit("data", Buffer.from(opts.body, "utf8"));
    req.emit("end");
  });
  const res: any = {
    statusCode: 0,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return { req, res };
}

async function post(events: unknown[], tamper?: "bad-sig" | "no-sig") {
  const body = JSON.stringify(events);
  const { signature, timestamp } = signRequest(body);
  const { req, res } = mockReqRes({
    body,
    signature: tamper === "no-sig" ? undefined : tamper === "bad-sig" ? "AAAA" : signature,
    timestamp,
  });
  await handler(req, res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  unsubscribes.clear();
  process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = PUBLIC_KEY_B64;
});

afterEach(() => {
  delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
});

it("rejects requests when no verification key is configured (fail closed)", async () => {
  delete process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  const res = await post([{ event: "bounce", email: "dead@example.com", seller_pubkey: PUBKEY }]);
  expect(res.statusCode).toBe(401);
  expect(mockUnsubscribeSellerEmail).not.toHaveBeenCalled();
});

it("rejects a forged batch with a bad signature and suppresses nothing", async () => {
  const res = await post(
    [{ event: "bounce", email: "dead@example.com", seller_pubkey: PUBKEY }],
    "bad-sig"
  );
  expect(res.statusCode).toBe(401);
  expect(mockUnsubscribeSellerEmail).not.toHaveBeenCalled();
});

it("rejects a batch with no signature headers at all", async () => {
  const res = await post(
    [{ event: "bounce", email: "dead@example.com", seller_pubkey: PUBKEY }],
    "no-sig"
  );
  expect(res.statusCode).toBe(401);
  expect(mockUnsubscribeSellerEmail).not.toHaveBeenCalled();
});

it("a signed bounce event lands the address on the seller's suppression list and a later broadcast skips it", async () => {
  // SendGrid ACCEPTED the original broadcast send (synchronous path saw ok),
  // then reported the bounce asynchronously via the webhook.
  const res = await post([
    {
      event: "bounce",
      email: "Dead@Example.com",
      seller_pubkey: PUBKEY,
      reason: "550 5.1.1 user unknown",
    },
  ]);
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ ok: true, suppressible: 1, suppressed: 1, failed: 0 });
  expect(mockUnsubscribeSellerEmail).toHaveBeenCalledWith(
    PUBKEY,
    "Dead@Example.com",
    "suppressed"
  );
  expect(unsubscribes.get(`${PUBKEY}|dead@example.com`)).toBe("suppressed");

  // A later broadcast builds its audience through the same suppression list
  // and never attempts the dead address.
  const outcome = await runOneTimeBroadcast({
    pubkey: PUBKEY,
    subject: "Hi",
    bodyHtml: "<p>Hello</p>",
  });
  expect(outcome.kind).toBe("sent");
  const attempted = mockSendDetailed.mock.calls.map((c) => c[0].to);
  expect(attempted).toEqual(["alive@example.com"]);
  expect(attempted).not.toContain("dead@example.com");
});

it("permanently-dropped and spamreport events suppress; delivered/open events are ignored", async () => {
  const res = await post([
    {
      event: "dropped",
      email: "drop@example.com",
      seller_pubkey: PUBKEY,
      reason: "Bounced Address",
    },
    { event: "spamreport", email: "spam@example.com", seller_pubkey: PUBKEY },
    { event: "delivered", email: "fine@example.com", seller_pubkey: PUBKEY },
    { event: "open", email: "open@example.com", seller_pubkey: PUBKEY },
  ]);
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ suppressible: 2, suppressed: 2, skipped: 2 });
  expect(unsubscribes.has(`${PUBKEY}|drop@example.com`)).toBe(true);
  expect(unsubscribes.has(`${PUBKEY}|spam@example.com`)).toBe(true);
  expect(unsubscribes.has(`${PUBKEY}|fine@example.com`)).toBe(false);
});

it("a dropped event from a transient block (no permanent reason) does NOT suppress — the rows never expire", async () => {
  const res = await post([
    // No reason at all: cause unknown, cannot prove permanence.
    { event: "dropped", email: "unknown@example.com", seller_pubkey: PUBKEY },
    // Throttling/content drops are transient or message-specific.
    {
      event: "dropped",
      email: "throttled@example.com",
      seller_pubkey: PUBKEY,
      reason: "Exceeded messaging limits",
    },
    {
      event: "dropped",
      email: "content@example.com",
      seller_pubkey: PUBKEY,
      reason: "Spam Content",
    },
  ]);
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ suppressible: 0, suppressed: 0, skipped: 3 });
  expect(mockUnsubscribeSellerEmail).not.toHaveBeenCalled();
});

it("a soft bounce (type=blocked, temporary throttling) does NOT suppress", async () => {
  const res = await post([
    {
      event: "bounce",
      email: "soft@example.com",
      seller_pubkey: PUBKEY,
      type: "blocked",
      reason: "421 Temporarily rejected due to IP reputation",
    },
    {
      event: "bounce",
      email: "hard@example.com",
      seller_pubkey: PUBKEY,
      type: "bounce",
      reason: "550 5.1.1 user unknown",
    },
  ]);
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ suppressible: 1, suppressed: 1, skipped: 1 });
  expect(unsubscribes.has(`${PUBKEY}|soft@example.com`)).toBe(false);
  expect(unsubscribes.get(`${PUBKEY}|hard@example.com`)).toBe("suppressed");
});

it("rejects an oversized body with 413 before signature verification", async () => {
  const big = `[${'{"event":"delivered"},'.repeat(30_000)}]`;
  expect(big.length).toBeGreaterThan(512 * 1024);
  const { signature, timestamp } = signRequest(big);
  const { req, res } = mockReqRes({ body: big, signature, timestamp });
  await handler(req, res);
  expect(res.statusCode).toBe(413);
  expect(mockUnsubscribeSellerEmail).not.toHaveBeenCalled();
});

it("events without seller attribution are skipped (covered by the cron sync instead)", async () => {
  const res = await post([
    { event: "bounce", email: "noarg@example.com" },
    { event: "bounce", seller_pubkey: PUBKEY },
  ]);
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ suppressible: 0, suppressed: 0, skipped: 2 });
  expect(mockUnsubscribeSellerEmail).not.toHaveBeenCalled();
});

it("a failed suppression write never fails the batch (cron sync is the backstop)", async () => {
  mockUnsubscribeSellerEmail.mockResolvedValueOnce(false);
  const res = await post([
    { event: "bounce", email: "dead@example.com", seller_pubkey: PUBKEY },
    { event: "bounce", email: "also-dead@example.com", seller_pubkey: PUBKEY },
  ]);
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ suppressible: 2, suppressed: 1, failed: 1 });
});
