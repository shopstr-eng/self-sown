/** @jest-environment node */

/**
 * Idempotency contract tests for the one-time broadcast service
 * (utils/email/one-time-broadcast.ts), which backs the send_broadcast_email
 * and send_test_email MCP tools.
 *
 * The pins that matter:
 *  - The claim (daily-cap row) is taken AFTER every skip early-return, so an
 *    empty audience or missing sender never burns budget.
 *  - The per-recipient ledger is keyed by CONTENT, so a retry with a fresh
 *    idempotency key still cannot re-email anyone, and a partial failure
 *    resumes only undelivered recipients.
 *  - A recipient claim is released only on a DEFINITE provider rejection
 *    (4xx); ambiguous failures (timeout/5xx) keep it (at-most-once).
 *  - A fully-failed fresh send releases the claim so the retry isn't
 *    cap-blocked; the recipient ledger still prevents duplicates.
 */

const mockGetSellerAudienceEmails: jest.Mock = jest.fn();
const mockClaimWithCap: jest.Mock = jest.fn();
const mockReleaseBroadcast: jest.Mock = jest.fn();
const mockGetRecipients: jest.Mock = jest.fn();
const mockClaimRecipient: jest.Mock = jest.fn();
const mockReleaseRecipient: jest.Mock = jest.fn();
const mockUnsubscribeSellerEmail: jest.Mock = jest.fn();
const mockIsSuppressedStrict: jest.Mock = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
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
  unsubscribeSellerEmail: (...args: unknown[]) =>
    mockUnsubscribeSellerEmail(...args),
  isSellerEmailUnsubscribedStrict: (...args: unknown[]) =>
    mockIsSuppressedStrict(...args),
}));

jest.mock("@/utils/db/email-sender-domains", () => ({
  resolveSellerSenderEmail: jest.fn(async () => "seller@shop.test"),
}));

jest.mock("@/utils/email/storefront-branding", () => ({
  loadStorefrontBranding: jest.fn(async () => null),
}));

const mockSendDetailed: jest.Mock = jest.fn();
const mockSendEmail: jest.Mock = jest.fn(async () => true);
jest.mock("@/utils/email/email-service", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
  sendEmailStrictFromDetailed: (...args: unknown[]) =>
    mockSendDetailed(...args),
}));

jest.mock("@/utils/email/unsubscribe-tokens", () => ({
  buildSellerEmailUnsubscribeUrl: jest.fn(() => "https://x.test/unsub?t=1"),
}));

jest.mock("@/utils/site-url", () => ({ getSiteUrl: () => "https://x.test" }));

import {
  runOneTimeBroadcast,
  sendOneTimeTestEmail,
} from "@/utils/email/one-time-broadcast";

const PUBKEY = "a".repeat(64);
const PARAMS = { pubkey: PUBKEY, subject: "Hi", bodyHtml: "<p>Hello</p>" };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSellerAudienceEmails.mockResolvedValue(["a@x.test", "b@x.test"]);
  mockGetRecipients.mockResolvedValue([]);
  mockClaimWithCap.mockResolvedValue("claimed");
  mockClaimRecipient.mockResolvedValue(true);
  mockUnsubscribeSellerEmail.mockResolvedValue(true);
  mockIsSuppressedStrict.mockResolvedValue(false);
  mockSendDetailed.mockResolvedValue({ ok: true, definiteReject: false });
});

describe("runOneTimeBroadcast", () => {
  it("never takes a claim when the audience is empty (claim AFTER skips)", async () => {
    mockGetSellerAudienceEmails.mockResolvedValue([]);
    const outcome = await runOneTimeBroadcast(PARAMS);
    expect(outcome).toEqual({ kind: "empty-audience" });
    expect(mockClaimWithCap).not.toHaveBeenCalled();
    expect(mockSendDetailed).not.toHaveBeenCalled();
  });

  it("sends to every audience member on a fresh claim", async () => {
    const outcome = await runOneTimeBroadcast(PARAMS);
    expect(outcome).toMatchObject({ kind: "sent", sent: 2, failed: 0 });
    expect(mockSendDetailed).toHaveBeenCalledTimes(2);
    // Recipients are claimed under the CONTENT key (not a claim key), so
    // dedupe survives a retry with a different idempotency key.
    const ledgerKeys = mockClaimRecipient.mock.calls.map((c) => c[1]);
    expect(new Set(ledgerKeys).size).toBe(1);
    expect(ledgerKeys[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resumes a partial send: delivered recipients are skipped on retry", async () => {
    mockGetRecipients.mockResolvedValue(["a@x.test"]);
    const outcome = await runOneTimeBroadcast({
      ...PARAMS,
      idempotencyKey: "retry-2", // a NEW key must not re-email a@x.test
    });
    expect(outcome).toMatchObject({ kind: "sent", sent: 1, failed: 0 });
    const sentTos = mockSendDetailed.mock.calls.map((c) => c[0].to);
    expect(sentTos).toEqual(["b@x.test"]);
  });

  it("reports already-sent when the content ledger covers the whole audience", async () => {
    mockGetRecipients.mockResolvedValue(["a@x.test", "b@x.test"]);
    const outcome = await runOneTimeBroadcast(PARAMS);
    expect(outcome).toEqual({ kind: "already-sent" });
    expect(mockClaimWithCap).not.toHaveBeenCalled();
  });

  it("keeps the recipient claim on an AMBIGUOUS failure (at-most-once)", async () => {
    mockSendDetailed.mockResolvedValue({ ok: false, definiteReject: false });
    const outcome = await runOneTimeBroadcast(PARAMS);
    expect(outcome).toMatchObject({ kind: "all-failed", failed: 2 });
    expect(mockReleaseRecipient).not.toHaveBeenCalled();
    // The fresh claim IS released (nothing provably delivered) so the retry
    // isn't blocked by the daily cap — the recipient ledger blocks dupes.
    expect(mockReleaseBroadcast).toHaveBeenCalledTimes(1);
  });

  it("releases the recipient claim on a DEFINITE rejection (4xx, nothing accepted)", async () => {
    mockSendDetailed.mockResolvedValue({ ok: false, definiteReject: true });
    await runOneTimeBroadcast(PARAMS);
    expect(mockReleaseRecipient).toHaveBeenCalledTimes(2);
    // Sender/account-level rejects must never suppress anyone.
    expect(mockUnsubscribeSellerEmail).not.toHaveBeenCalled();
  });

  it("suppresses a recipient-level reject BEFORE releasing its claim", async () => {
    mockSendDetailed.mockResolvedValue({
      ok: false,
      definiteReject: true,
      recipientReject: true,
    });
    const outcome = await runOneTimeBroadcast(PARAMS);
    expect(outcome).toMatchObject({ kind: "all-failed", failed: 2 });
    for (const email of ["a@x.test", "b@x.test"]) {
      expect(mockUnsubscribeSellerEmail).toHaveBeenCalledWith(
        PUBKEY,
        email,
        "suppressed"
      );
    }
    // The claim is released only AFTER the suppression lands, so a retry
    // racing the rejection path can never reclaim an un-suppressed address.
    const suppressOrder =
      mockUnsubscribeSellerEmail.mock.invocationCallOrder[0];
    const releaseOrder = mockReleaseRecipient.mock.invocationCallOrder[0];
    expect(suppressOrder).toBeDefined();
    expect(releaseOrder).toBeDefined();
    expect(suppressOrder!).toBeLessThan(releaseOrder!);
    expect(mockReleaseRecipient).toHaveBeenCalledTimes(2);
  });

  it("keeps the recipient claim when the suppression write fails (fail closed)", async () => {
    mockSendDetailed.mockResolvedValue({
      ok: false,
      definiteReject: true,
      recipientReject: true,
    });
    mockUnsubscribeSellerEmail.mockResolvedValue(false); // DB error
    const outcome = await runOneTimeBroadcast(PARAMS);
    expect(outcome).toMatchObject({ kind: "all-failed", failed: 2 });
    // The claims STAY: the retained ledger rows keep the un-suppressed dead
    // addresses off every retry, exactly like an ambiguous failure.
    expect(mockReleaseRecipient).not.toHaveBeenCalled();
  });

  it("a retry paused between audience selection and recipient claim until suppression+release finish never re-sends the dead address", async () => {
    // Deterministic interleaving of the race:
    //  1. The RETRY starts first and reads the audience BEFORE any
    //     suppression exists (dead@x.test still listed) — then parks at the
    //     per-recipient claim.
    //  2. The FIRST broadcast runs to completion: its send is refused with a
    //     recipient-level reject, so it suppresses the address and THEN
    //     releases the claim.
    //  3. The retry unblocks, successfully RECLAIMS the released row (its
    //     audience snapshot is stale and its ledger read was empty), and
    //     must be stopped by the post-claim suppression recheck alone.
    const DEAD = "dead@x.test";
    mockGetSellerAudienceEmails.mockResolvedValue([DEAD]);
    mockGetRecipients.mockResolvedValue([]);
    mockSendDetailed.mockResolvedValue({
      ok: false,
      definiteReject: true,
      recipientReject: true,
    });

    // Suppression state backed by a real flag: false until the first
    // broadcast's unsubscribeSellerEmail lands, true afterwards — so each
    // run's post-claim recheck sees the state of that moment.
    let suppressed = false;
    mockUnsubscribeSellerEmail.mockImplementation(async () => {
      suppressed = true;
      return true;
    });
    mockIsSuppressedStrict.mockImplementation(async () => suppressed);

    // Park the RETRY at its recipient claim (the FIRST claim call, since
    // the retry starts first) until the first broadcast has finished.
    let releaseRetryClaim!: () => void;
    const retryClaimGate = new Promise<void>((resolve) => {
      releaseRetryClaim = resolve;
    });
    let claimCalls = 0;
    mockClaimRecipient.mockImplementation(async () => {
      claimCalls++;
      if (claimCalls === 1) await retryClaimGate; // the retry parks here
      return true; // the row was released by the first broadcast
    });

    const retryPromise = runOneTimeBroadcast(PARAMS);
    // Let the retry reach its parked claim before the first broadcast runs.
    while (claimCalls === 0) await new Promise((r) => setImmediate(r));

    const first = await runOneTimeBroadcast(PARAMS);
    expect(first).toMatchObject({ kind: "all-failed", failed: 1 });
    expect(suppressed).toBe(true);

    releaseRetryClaim();
    const retry = await retryPromise;

    // The retry reclaimed the released claim with a stale snapshot but the
    // post-claim recheck saw the suppression — zero additional sends.
    expect(mockSendDetailed).toHaveBeenCalledTimes(1);
    expect(retry).toMatchObject({ kind: "sent", sent: 0, failed: 0 });
  });

  it("fails closed when the post-claim suppression recheck errors (no send, claim kept)", async () => {
    mockIsSuppressedStrict.mockResolvedValue(null); // DB error = unknown
    const outcome = await runOneTimeBroadcast(PARAMS);
    expect(outcome).toMatchObject({ kind: "all-failed", failed: 2 });
    expect(mockSendDetailed).not.toHaveBeenCalled();
    // Claims STAY: unknown suppression state must never become a send.
    expect(mockReleaseRecipient).not.toHaveBeenCalled();
  });

  it("does not release the claim when a RETRY fully fails (claim already counted)", async () => {
    mockClaimWithCap.mockResolvedValue("exists");
    mockSendDetailed.mockResolvedValue({ ok: false, definiteReject: false });
    const outcome = await runOneTimeBroadcast(PARAMS);
    expect(outcome.kind).toBe("all-failed");
    expect(mockReleaseBroadcast).not.toHaveBeenCalled();
  });

  it("honors the daily cap", async () => {
    mockClaimWithCap.mockResolvedValue("limit");
    const outcome = await runOneTimeBroadcast(PARAMS);
    expect(outcome).toEqual({ kind: "daily-limit" });
    expect(mockSendDetailed).not.toHaveBeenCalled();
  });

  it("rejects reuse of an idempotency key with different content", async () => {
    mockClaimWithCap.mockResolvedValue("mismatch");
    const outcome = await runOneTimeBroadcast({
      ...PARAMS,
      idempotencyKey: "k1",
    });
    expect(outcome).toEqual({ kind: "key-mismatch" });
    expect(mockSendDetailed).not.toHaveBeenCalled();
  });

  it("fails closed when the seller has no verified sender domain", async () => {
    const { resolveSellerSenderEmail } = jest.requireMock(
      "@/utils/db/email-sender-domains"
    );
    resolveSellerSenderEmail.mockResolvedValueOnce(null);
    const outcome = await runOneTimeBroadcast(PARAMS);
    expect(outcome).toEqual({ kind: "no-sender" });
    expect(mockGetSellerAudienceEmails).not.toHaveBeenCalled();
    expect(mockSendDetailed).not.toHaveBeenCalled();
  });
});

describe("sendOneTimeTestEmail", () => {
  it("rejects a malformed address before any claim", async () => {
    const result = await sendOneTimeTestEmail({ ...PARAMS, to: "nope" });
    expect(result.ok).toBe(false);
    expect(mockClaimWithCap).not.toHaveBeenCalled();
  });

  it("sends with a [TEST] subject prefix", async () => {
    const result = await sendOneTimeTestEmail({
      ...PARAMS,
      to: "me@x.test",
    });
    expect(result).toEqual({ ok: true });
    expect(mockSendEmail).toHaveBeenCalledWith(
      "me@x.test",
      expect.stringContaining("[TEST]"),
      expect.any(String)
    );
    // The claim key carries a UTC day bucket so attempts (not just distinct
    // content) are capped per day.
    expect(mockClaimWithCap.mock.calls[0][1]).toMatch(/^test:\d{8}:/);
  });

  it("blocks re-sending an identical test email the same day", async () => {
    mockClaimWithCap.mockResolvedValue("exists");
    const result = await sendOneTimeTestEmail({
      ...PARAMS,
      to: "me@x.test",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already sent/i);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("enforces the daily test-send cap", async () => {
    mockClaimWithCap.mockResolvedValue("limit");
    const result = await sendOneTimeTestEmail({
      ...PARAMS,
      to: "me@x.test",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/limit/i);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
