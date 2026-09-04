/** @jest-environment node */

/**
 * Per-segment blog broadcast behavior (#154): the same published post version
 * can be emailed once to popup contacts, once to subscription contacts, and
 * once to the full audience — but a contact must NEVER receive the same
 * version twice. Dedup is driven by the immutable per-recipient ledger
 * (blog_email_broadcast_recipients), NOT by current segment membership,
 * because a capture's source is mutable (subscription -> popup when they
 * later claim a welcome offer). runBlogBroadcast runs for real; the DB +
 * SendGrid layer is mocked at the module boundary.
 */

import { runBlogBroadcast } from "@/utils/email/blog-broadcast";
import {
  fetchBlogPostByDTagAndPubkey,
  fetchBlogPostsByPubkeyFromDb,
  getSellerAudienceEmails,
  claimBlogBroadcast,
  releaseBlogBroadcast,
  getBlogBroadcastSegments,
  getBlogBroadcastRecipients,
  claimBlogBroadcastRecipient,
  releaseBlogBroadcastRecipient,
  getShopSlugByPubkey,
} from "@/utils/db/db-service";
import { resolveSellerSenderEmail } from "@/utils/db/email-sender-domains";
import { loadStorefrontBranding } from "@/utils/email/storefront-branding";
import { sendEmailStrictFrom } from "@/utils/email/email-service";
import { buildSellerEmailUnsubscribeUrl } from "@/utils/email/unsubscribe-tokens";

jest.mock("@/utils/db/db-service", () => ({
  fetchBlogPostByDTagAndPubkey: jest.fn(),
  fetchBlogPostsByPubkeyFromDb: jest.fn(),
  getSellerAudienceEmails: jest.fn(),
  claimBlogBroadcast: jest.fn(),
  releaseBlogBroadcast: jest.fn(),
  getBlogBroadcastSegments: jest.fn(),
  getBlogBroadcastRecipients: jest.fn(),
  claimBlogBroadcastRecipient: jest.fn(),
  releaseBlogBroadcastRecipient: jest.fn(),
  getShopSlugByPubkey: jest.fn(),
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
  fetchBlogPostByDTagAndPubkey: fetchBlogPostByDTagAndPubkey as jest.Mock,
  fetchBlogPostsByPubkeyFromDb: fetchBlogPostsByPubkeyFromDb as jest.Mock,
  getSellerAudienceEmails: getSellerAudienceEmails as jest.Mock,
  claimBlogBroadcast: claimBlogBroadcast as jest.Mock,
  releaseBlogBroadcast: releaseBlogBroadcast as jest.Mock,
  getBlogBroadcastSegments: getBlogBroadcastSegments as jest.Mock,
  getBlogBroadcastRecipients: getBlogBroadcastRecipients as jest.Mock,
  claimBlogBroadcastRecipient: claimBlogBroadcastRecipient as jest.Mock,
  releaseBlogBroadcastRecipient: releaseBlogBroadcastRecipient as jest.Mock,
  getShopSlugByPubkey: getShopSlugByPubkey as jest.Mock,
  resolveSellerSenderEmail: resolveSellerSenderEmail as jest.Mock,
  loadStorefrontBranding: loadStorefrontBranding as jest.Mock,
  sendEmailStrictFrom: sendEmailStrictFrom as jest.Mock,
  buildSellerEmailUnsubscribeUrl: buildSellerEmailUnsubscribeUrl as jest.Mock,
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

function emailedRecipients(): string[] {
  return mocked.sendEmailStrictFrom.mock.calls.map((c) => c[0].to as string);
}

beforeEach(() => {
  jest.clearAllMocks();
  mocked.fetchBlogPostByDTagAndPubkey.mockResolvedValue(blogEvent());
  mocked.fetchBlogPostsByPubkeyFromDb.mockResolvedValue([blogEvent()]);
  mocked.resolveSellerSenderEmail.mockResolvedValue("shop@verified.example");
  mocked.buildSellerEmailUnsubscribeUrl.mockReturnValue(
    "https://milk.market/api/email/unsubscribe?token=x"
  );
  mocked.getShopSlugByPubkey.mockResolvedValue("myshop");
  mocked.loadStorefrontBranding.mockResolvedValue({ shopName: "My Shop" });
  mocked.sendEmailStrictFrom.mockResolvedValue(true);
  mocked.claimBlogBroadcast.mockResolvedValue(true);
  mocked.releaseBlogBroadcast.mockResolvedValue(undefined);
  // No prior segment claims or delivered recipients for this version.
  mocked.getBlogBroadcastSegments.mockResolvedValue([]);
  mocked.getBlogBroadcastRecipients.mockResolvedValue([]);
  mocked.claimBlogBroadcastRecipient.mockResolvedValue(true);
  mocked.releaseBlogBroadcastRecipient.mockResolvedValue(undefined);
  mocked.getSellerAudienceEmails.mockResolvedValue(["a@example.com"]);
});

describe("runBlogBroadcast — per-segment sends", () => {
  it("a popup-segment send claims the POPUP segment and emails only popup contacts", async () => {
    mocked.getSellerAudienceEmails.mockImplementation(
      async (_pk: string, source?: string) =>
        source === "popup" ? ["popup@example.com"] : ["buyer@example.com"]
    );

    const outcome = await runBlogBroadcast({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      audienceSource: "popup",
    });

    expect(outcome).toMatchObject({ kind: "sent", sent: 1, total: 1 });
    expect(mocked.claimBlogBroadcast).toHaveBeenCalledWith(
      PUBKEY,
      D_TAG,
      EVENT_ID,
      "popup"
    );
    // Each emailed recipient was atomically claimed first.
    expect(mocked.claimBlogBroadcastRecipient).toHaveBeenCalledWith(
      PUBKEY,
      D_TAG,
      EVENT_ID,
      "popup@example.com"
    );
    expect(emailedRecipients()).toEqual(["popup@example.com"]);
  });

  it("a full send AFTER a popup send excludes the already-delivered popup contacts", async () => {
    // The popup segment already ran; its recipients are in the ledger.
    mocked.getBlogBroadcastSegments.mockResolvedValue(["popup"]);
    mocked.getBlogBroadcastRecipients.mockResolvedValue(["popup@example.com"]);
    mocked.getSellerAudienceEmails.mockResolvedValue([
      "buyer@example.com",
      "popup@example.com",
    ]);

    const outcome = await runBlogBroadcast({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
    });

    // Only the buyer is emailed; the popup contact is NOT re-emailed.
    expect(outcome).toMatchObject({ kind: "sent", sent: 1, total: 1 });
    expect(emailedRecipients()).toEqual(["buyer@example.com"]);
    expect(mocked.claimBlogBroadcast).toHaveBeenCalledWith(
      PUBKEY,
      D_TAG,
      EVENT_ID,
      undefined
    );
  });

  it("exclusion still holds after a contact's capture flips subscription -> popup", async () => {
    // REGRESSION (review): the contact was emailed by a SUBSCRIPTION send,
    // then claimed a welcome offer, which flips their single capture row's
    // source to 'popup'. A membership-based exclusion would no longer find
    // them under 'subscription' and the full send would re-email them. The
    // immutable recipient ledger must still exclude them.
    mocked.getBlogBroadcastSegments.mockResolvedValue(["subscription"]);
    mocked.getBlogBroadcastRecipients.mockResolvedValue(["flip@example.com"]);
    // Current unscoped audience still contains them (now via the popup row).
    mocked.getSellerAudienceEmails.mockResolvedValue([
      "buyer@example.com",
      "flip@example.com",
    ]);

    const outcome = await runBlogBroadcast({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
    });

    expect(outcome).toMatchObject({ kind: "sent", sent: 1, total: 1 });
    expect(emailedRecipients()).toEqual(["buyer@example.com"]);
  });

  it("a segment send AFTER a full send is skipped as already-sent (no claim, no email)", async () => {
    mocked.getBlogBroadcastSegments.mockResolvedValue(["all"]);

    const outcome = await runBlogBroadcast({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      audienceSource: "subscription",
    });

    expect(outcome).toEqual({ kind: "skipped", reason: "already-sent" });
    expect(mocked.claimBlogBroadcast).not.toHaveBeenCalled();
    expect(mocked.sendEmailStrictFrom).not.toHaveBeenCalled();
  });

  it("a full send with everyone already delivered skips WITHOUT burning the claim", async () => {
    // Both segments claimed and both contacts already delivered.
    mocked.getBlogBroadcastSegments.mockResolvedValue([
      "popup",
      "subscription",
    ]);
    mocked.getBlogBroadcastRecipients.mockResolvedValue([
      "popup@example.com",
      "sub@example.com",
    ]);
    mocked.getSellerAudienceEmails.mockResolvedValue([
      "popup@example.com",
      "sub@example.com",
    ]);

    const outcome = await runBlogBroadcast({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
    });

    expect(outcome).toEqual({ kind: "skipped", reason: "already-sent" });
    // Crucially the 'all' claim is NOT taken — contacts who join later must
    // still be reachable by a future full send.
    expect(mocked.claimBlogBroadcast).not.toHaveBeenCalled();
    expect(mocked.sendEmailStrictFrom).not.toHaveBeenCalled();
  });

  it("a contact claimed by a CONCURRENT send is skipped, not double-emailed", async () => {
    // Simulate a racing cross-segment send that wins the per-recipient claim.
    mocked.getSellerAudienceEmails.mockResolvedValue([
      "a@example.com",
      "b@example.com",
    ]);
    mocked.claimBlogBroadcastRecipient.mockImplementation(
      async (_pk: string, _dt: string, _ev: string, email: string) =>
        email !== "b@example.com"
    );

    const outcome = await runBlogBroadcast({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
    });

    expect(emailedRecipients()).toEqual(["a@example.com"]);
    expect(outcome).toMatchObject({ kind: "sent", sent: 1 });
    // A lost claim is not a failure and must NOT be released.
    expect(mocked.releaseBlogBroadcastRecipient).not.toHaveBeenCalled();
  });

  it("a send that loses EVERY recipient claim releases its version claim, so late joiners stay reachable", async () => {
    // A concurrent popup send claims the only current recipient; this full
    // send wins the version claim but owns zero deliveries.
    mocked.getSellerAudienceEmails.mockResolvedValue(["a@example.com"]);
    mocked.claimBlogBroadcastRecipient.mockResolvedValue(false);

    const first = await runBlogBroadcast({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
    });

    expect(first).toMatchObject({ kind: "sent", sent: 0, failed: 0 });
    // The version claim was released — not burned.
    expect(mocked.releaseBlogBroadcast).toHaveBeenCalledWith(
      PUBKEY,
      D_TAG,
      EVENT_ID,
      undefined
    );

    // ...so a later full send CAN reach a buyer who joined afterwards.
    mocked.claimBlogBroadcast.mockResolvedValue(true);
    mocked.getSellerAudienceEmails.mockResolvedValue(["newbuyer@example.com"]);
    mocked.claimBlogBroadcastRecipient.mockResolvedValue(true);

    const second = await runBlogBroadcast({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
    });

    expect(second).toMatchObject({ kind: "sent", sent: 1 });
    expect(emailedRecipients()).toEqual(["newbuyer@example.com"]);
  });

  it("re-sending the SAME segment for the same version is still blocked", async () => {
    // The per-segment claim key rejects the second popup send.
    mocked.claimBlogBroadcast.mockResolvedValue(false);

    const outcome = await runBlogBroadcast({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      audienceSource: "popup",
    });

    expect(outcome).toEqual({ kind: "skipped", reason: "already-sent" });
    expect(mocked.sendEmailStrictFrom).not.toHaveBeenCalled();
  });

  it("a total send failure releases BOTH the recipient claims and the same-segment version claim", async () => {
    mocked.sendEmailStrictFrom.mockResolvedValue(false);

    const outcome = await runBlogBroadcast({
      pubkey: PUBKEY,
      dTag: D_TAG,
      eventId: EVENT_ID,
      audienceSource: "popup",
    });

    expect(outcome.kind).toBe("all-failed");
    // The failed delivery frees the recipient so a retry re-attempts...
    expect(mocked.releaseBlogBroadcastRecipient).toHaveBeenCalledWith(
      PUBKEY,
      D_TAG,
      EVENT_ID,
      "a@example.com"
    );
    // ...and the version claim is released for the SAME segment.
    expect(mocked.releaseBlogBroadcast).toHaveBeenCalledWith(
      PUBKEY,
      D_TAG,
      EVENT_ID,
      "popup"
    );
  });
});
