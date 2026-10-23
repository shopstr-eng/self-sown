/** @jest-environment node */

// get-subscriptions returns full subscription rows (including the buyer's
// shipping address), so reads authenticate like the cancel/update mutations:
// the pubkey path requires a signed Nostr request proof whose signer IS the
// pubkey being read; the guest email path requires the unguessable Stripe
// subscription id as a capability — never the sequential row id.

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import handler from "@/pages/api/stripe/get-subscriptions";
import {
  buildCancelSubscriptionProof,
  buildListSubscriptionsProof,
  buildSignedHttpRequestProofTemplate,
  SIGNED_EVENT_HEADER,
} from "@/utils/nostr/request-auth";
import {
  getSubscriptionsByBuyerPubkey,
  getSubscriptionsByBuyerEmail,
} from "@/utils/db/db-service";

jest.mock("@/utils/db/db-service", () => ({
  getSubscriptionsByBuyerPubkey: jest.fn(),
  getSubscriptionsByBuyerEmail: jest.fn(),
}));
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn().mockResolvedValue(true),
}));

const pubkeyMock = getSubscriptionsByBuyerPubkey as jest.Mock;
const emailMock = getSubscriptionsByBuyerEmail as jest.Mock;

const ROW = {
  id: 7,
  stripe_subscription_id: "sub_secret_1N23",
  stripe_customer_id: "cus_123",
  buyer_pubkey: "buyer-pubkey",
  buyer_email: "buyer@example.com",
  seller_pubkey: "seller-pubkey",
  shipping_address: { line1: "1 Farm Rd" },
};

function makeRes() {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  return res;
}

function makeReq(query: Record<string, string>, signedEventHeader?: string) {
  return {
    method: "GET",
    query,
    headers: signedEventHeader
      ? { [SIGNED_EVENT_HEADER]: signedEventHeader }
      : {},
  } as any;
}

function signHeader(
  proof: Parameters<typeof buildSignedHttpRequestProofTemplate>[0],
  secretKey: Uint8Array
): string {
  return JSON.stringify(
    finalizeEvent(buildSignedHttpRequestProofTemplate(proof), secretKey)
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  pubkeyMock.mockResolvedValue([ROW]);
  emailMock.mockResolvedValue([ROW]);
});

describe("GET /api/stripe/get-subscriptions", () => {
  it("rejects non-GET methods", async () => {
    const res = makeRes();
    await handler({ method: "POST", query: {}, headers: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("rejects a pubkey read with no signed proof", async () => {
    const res = makeRes();
    await handler(makeReq({ pubkey: "buyer-pubkey" }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(pubkeyMock).not.toHaveBeenCalled();
  });

  it("rejects a proof signed by a different key than the queried pubkey", async () => {
    const attackerKey = generateSecretKey();
    const res = makeRes();
    await handler(
      makeReq(
        { pubkey: "buyer-pubkey" },
        signHeader(buildListSubscriptionsProof("buyer-pubkey"), attackerKey)
      ),
      res
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(pubkeyMock).not.toHaveBeenCalled();
  });

  it("rejects a replayed cancel-subscription proof (wrong action)", async () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const res = makeRes();
    await handler(
      makeReq(
        { pubkey },
        signHeader(
          buildCancelSubscriptionProof({
            pubkey,
            subscriptionId: "sub_secret_1N23",
          }),
          secretKey
        )
      ),
      res
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(pubkeyMock).not.toHaveBeenCalled();
  });

  it("returns rows when the buyer signs a list_subscriptions proof", async () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const res = makeRes();
    await handler(
      makeReq(
        { pubkey },
        signHeader(buildListSubscriptionsProof(pubkey), secretKey)
      ),
      res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(pubkeyMock).toHaveBeenCalledWith(pubkey);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      subscriptions: [ROW],
    });
  });

  it("requires a subscriptionId for guest email lookups", async () => {
    const res = makeRes();
    await handler(makeReq({ email: "buyer@example.com" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("returns nothing when the subscriptionId does not match", async () => {
    const res = makeRes();
    await handler(
      makeReq({ email: "buyer@example.com", subscriptionId: "sub_wrong" }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      subscriptions: [],
    });
  });

  it("does not accept the sequential row id as the capability", async () => {
    const res = makeRes();
    await handler(
      makeReq({ email: "buyer@example.com", subscriptionId: "7" }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      subscriptions: [],
    });
  });

  it("returns only the matching row for email + Stripe subscription id", async () => {
    emailMock.mockResolvedValue([
      ROW,
      { ...ROW, id: 8, stripe_subscription_id: "sub_other_9Z" },
    ]);
    const res = makeRes();
    await handler(
      makeReq({
        email: "buyer@example.com",
        subscriptionId: "sub_secret_1N23",
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      subscriptions: [ROW],
    });
  });

  it("a returning guest can look up their subscription with the ID exactly as delivered in the confirmation email", async () => {
    // The capability only works if the ID the buyer actually receives renders
    // verbatim. Render the real confirmation template, pull the ID back out
    // of the HTML, and use it as-is against the guest lookup.
    const { subscriptionConfirmationEmail } = await import(
      "@/utils/email/email-templates"
    );
    const { html } = subscriptionConfirmationEmail({
      productTitle: "Raw Milk",
      frequency: "weekly",
      discountPercent: 10,
      regularPrice: "10",
      subscriptionPrice: "9",
      currency: "USD",
      nextBillingDate: "November 1, 2026",
      subscriptionId: ROW.stripe_subscription_id,
    });
    const match = html.match(/sub_[A-Za-z0-9_]+/);
    expect(match?.[0]).toBe(ROW.stripe_subscription_id);

    const res = makeRes();
    await handler(
      makeReq({
        email: "buyer@example.com",
        subscriptionId: match![0],
      }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      subscriptions: [ROW],
    });
  });
});
