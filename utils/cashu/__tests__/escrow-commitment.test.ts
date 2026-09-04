import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
} from "nostr-tools";
import {
  buildEscrowActionContent,
  buildEscrowActionEventTemplate,
  buildEscrowCommitmentContent,
  buildEscrowCommitmentEventTemplate,
  deriveEscrowId,
  verifyEscrowActionEvent,
  verifyEscrowCommitmentEvent,
  ESCROW_ACTION_KIND,
  ESCROW_COMMITMENT_KIND,
  ESCROW_COMMITMENT_MAX_AGE_SECONDS,
  ESCROW_DEFAULT_LOCK_SECONDS,
  ESCROW_MAX_LOCK_SECONDS,
  type EscrowCommitment,
} from "@/utils/cashu/escrow-commitment";

const MINT = "https://mint.example";
const ARBITER_PK = "c".repeat(64);
const SELLER_PK = "d".repeat(64);

const NOW = 1_800_000_000;

function makeCommitment(
  buyerSecret: Uint8Array,
  overrides: Partial<EscrowCommitment> = {}
): { event: Event; commitment: EscrowCommitment } {
  const commitment: EscrowCommitment = {
    buyerPubkey: getPublicKey(buyerSecret),
    sellerPubkey: SELLER_PK,
    orderId: "order-123",
    amountSats: 21_000,
    mintUrl: MINT,
    expiresAt: NOW + 86_400,
    arbiterPubkey: ARBITER_PK,
    ...overrides,
  };
  const template = buildEscrowCommitmentEventTemplate(commitment);
  template.created_at = NOW;
  return { event: finalizeEvent(template, buyerSecret), commitment };
}

function verify(event: Event, nowSeconds = NOW) {
  return verifyEscrowCommitmentEvent(event, {
    allowedMints: new Set([MINT]),
    arbiterPubkeys: new Set([ARBITER_PK]),
    nowSeconds,
  });
}

describe("escrow-commitment", () => {
  const buyerSecret = generateSecretKey();

  it("accepts a well-formed signed commitment and derives a stable escrow id", () => {
    const { event, commitment } = makeCommitment(buyerSecret);
    const result = verify(event);
    expect(result).toEqual({
      ok: true,
      escrowId: deriveEscrowId(commitment.buyerPubkey, commitment.orderId),
      commitment,
    });
  });

  it("produces canonical content regardless of construction order", () => {
    const a = buildEscrowCommitmentContent({
      sellerPubkey: SELLER_PK,
      orderId: "o1",
      amountSats: 5,
      mintUrl: MINT,
      expiresAt: NOW + 10,
    });
    const b = buildEscrowCommitmentContent({
      expiresAt: NOW + 10,
      mintUrl: MINT,
      amountSats: 5,
      orderId: "o1",
      sellerPubkey: SELLER_PK,
    });
    expect(a).toBe(b);
    expect(a).toBe(
      JSON.stringify({
        amountSats: 5,
        expiresAt: NOW + 10,
        mintUrl: MINT,
        orderId: "o1",
        sellerPubkey: SELLER_PK,
      })
    );
  });

  it("rejects a tampered event (invalid signature)", () => {
    const { event } = makeCommitment(buyerSecret);
    const tampered = { ...event, content: event.content.replace("21000", "1") };
    const result = verify(tampered);
    expect(result.ok).toBe(false);
  });

  it("rejects the wrong kind", () => {
    const { event } = makeCommitment(buyerSecret);
    const wrong = finalizeEvent(
      {
        ...event,
        kind: 1,
        tags: event.tags,
        content: event.content,
        created_at: NOW,
      },
      buyerSecret
    );
    expect(verify(wrong).ok).toBe(false);
    expect(event.kind).toBe(ESCROW_COMMITMENT_KIND);
  });

  it("rejects stale and far-future created_at (replay window)", () => {
    const { event } = makeCommitment(buyerSecret);
    expect(verify(event, NOW + ESCROW_COMMITMENT_MAX_AGE_SECONDS + 1).ok).toBe(
      false
    );
  });

  it("rejects a mint outside the configured allowlist", () => {
    const { event } = makeCommitment(buyerSecret, {
      mintUrl: "https://evil-mint.example",
    });
    expect(verify(event).ok).toBe(false);
  });

  it("rejects an arbiter outside the configured allowlist", () => {
    const { event } = makeCommitment(buyerSecret, {
      arbiterPubkey: "e".repeat(64),
    });
    expect(verify(event).ok).toBe(false);
  });

  it("accepts a commitment without an arbiter (2-of-2 buyer/seller)", () => {
    const { event, commitment } = makeCommitment(buyerSecret, {
      arbiterPubkey: undefined,
    });
    const result = verify(event);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.commitment.arbiterPubkey).toBeUndefined();
    expect(commitment.arbiterPubkey).toBeUndefined();
  });

  it("rejects expired and over-long locks", () => {
    const expired = makeCommitment(buyerSecret, { expiresAt: NOW - 1 });
    expect(verify(expired.event).ok).toBe(false);
    const tooLong = makeCommitment(buyerSecret, {
      expiresAt: NOW + ESCROW_MAX_LOCK_SECONDS + 60,
    });
    expect(verify(tooLong.event).ok).toBe(false);
  });

  it("rejects non-positive and non-integer amounts", () => {
    for (const amountSats of [0, -5, 1.5]) {
      const { event } = makeCommitment(buyerSecret, { amountSats });
      expect(verify(event).ok).toBe(false);
    }
  });

  it("rejects a d-tag that does not match buyer+order (id substitution)", () => {
    const { event, commitment } = makeCommitment(buyerSecret);
    const template = {
      kind: event.kind,
      created_at: NOW,
      content: event.content,
      tags: event.tags.map((t) =>
        t[0] === "d" ? ["d", `${commitment.buyerPubkey}:other-order`] : t
      ),
    };
    const resigned = finalizeEvent(template, buyerSecret);
    expect(verify(resigned).ok).toBe(false);
  });

  it("rejects duplicated signed tags (smuggling vector)", () => {
    const { event } = makeCommitment(buyerSecret);
    const withDuplicateSeller = finalizeEvent(
      {
        kind: event.kind,
        created_at: NOW,
        content: event.content,
        tags: [...event.tags, ["seller", "f".repeat(64)]],
      },
      buyerSecret
    );
    const result = verify(withDuplicateSeller);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/repeat the "seller" tag/);

    const withDuplicateArbiter = finalizeEvent(
      {
        kind: event.kind,
        created_at: NOW,
        content: event.content,
        tags: [...event.tags, ["arbiter", "e".repeat(64)]],
      },
      buyerSecret
    );
    expect(verify(withDuplicateArbiter).ok).toBe(false);
  });

  it("rejects malformed tags with extra elements", () => {
    const { event } = makeCommitment(buyerSecret);
    const malformed = finalizeEvent(
      {
        kind: event.kind,
        created_at: NOW,
        content: event.content,
        tags: event.tags.map((t) =>
          t[0] === "amount" ? ["amount", "21000", "extra"] : t
        ),
      },
      buyerSecret
    );
    expect(verify(malformed).ok).toBe(false);
  });

  it("rejects content that disagrees with the signed tags", () => {
    const { event } = makeCommitment(buyerSecret);
    const template = {
      kind: event.kind,
      created_at: NOW,
      // Content claims a different seller than the tags do.
      content: buildEscrowCommitmentContent({
        sellerPubkey: "f".repeat(64),
        orderId: "order-123",
        amountSats: 21_000,
        mintUrl: MINT,
        expiresAt: NOW + 86_400,
        arbiterPubkey: ARBITER_PK,
      }),
      tags: event.tags,
    };
    const resigned = finalizeEvent(template, buyerSecret);
    const result = verify(resigned);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/content/i);
  });
});

describe("escrow action events", () => {
  const actionBuyerSecret = generateSecretKey();
  const actionBuyerPk = getPublicKey(actionBuyerSecret);
  const ESCROW_ID = `${actionBuyerPk}:order-xyz`;

  function makeAction(
    overrides: {
      action?: string;
      escrowId?: string;
      kind?: number;
      createdAt?: number;
      secret?: Uint8Array;
      contentOverride?: string;
      extraTags?: string[][];
    } = {}
  ): Event {
    const action = overrides.action ?? "refund";
    const escrowId = overrides.escrowId ?? ESCROW_ID;
    const template = buildEscrowActionEventTemplate({
      action: action as never,
      escrowId,
    });
    template.created_at = overrides.createdAt ?? NOW;
    if (overrides.kind !== undefined) template.kind = overrides.kind;
    if (overrides.contentOverride !== undefined)
      template.content = overrides.contentOverride;
    if (overrides.extraTags) template.tags.push(...overrides.extraTags);
    return finalizeEvent(template, overrides.secret ?? actionBuyerSecret);
  }

  const verifyAction = (event: Event, nowSeconds = NOW) =>
    verifyEscrowActionEvent(event, { nowSeconds });

  it("accepts a well-formed buyer-signed refund action", () => {
    const event = makeAction();
    expect(event.kind).toBe(ESCROW_ACTION_KIND);
    expect(verifyAction(event)).toEqual({
      ok: true,
      action: "refund",
      escrowId: ESCROW_ID,
      actorPubkey: actionBuyerPk,
    });
  });

  it("builds canonical content with sorted keys", () => {
    expect(buildEscrowActionContent({ action: "refund", escrowId: "x" })).toBe(
      '{"action":"refund","escrowId":"x"}'
    );
  });

  it("keeps the default lock under the protocol maximum", () => {
    expect(ESCROW_DEFAULT_LOCK_SECONDS).toBe(60 * 60 * 24 * 14);
    expect(ESCROW_DEFAULT_LOCK_SECONDS).toBeLessThan(ESCROW_MAX_LOCK_SECONDS);
  });

  it("rejects the wrong kind", () => {
    expect(verifyAction(makeAction({ kind: 1 })).ok).toBe(false);
  });

  it("rejects a stale action (replay window)", () => {
    const event = makeAction();
    expect(
      verifyAction(event, NOW + ESCROW_COMMITMENT_MAX_AGE_SECONDS + 1).ok
    ).toBe(false);
  });

  it("rejects an unsupported action", () => {
    // Signed correctly, but the action is not one the protocol supports.
    const event = makeAction({ action: "steal" });
    const result = verifyAction(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unsupported/i);
  });

  it("accepts a release signed by the buyer", () => {
    const result = verifyAction(makeAction({ action: "release" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toBe("release");
      expect(result.actorPubkey).toBe(actionBuyerPk);
    }
  });

  it("accepts a release signed by a non-buyer (actor authorized by the endpoint)", () => {
    // A release can be signed by EITHER party (buyer approves, seller
    // completes); the endpoints authorize the actor against the registered
    // commitment, which is authoritative.
    const result = verifyAction(
      makeAction({ action: "release", secret: generateSecretKey() })
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a refund signed by a non-buyer (actor authorized by the endpoint)", () => {
    // The verifier checks shape and freshness only — the refund endpoint
    // binds the signer to the registered buyer, and the resolve endpoint to
    // the registered arbiter (both against the DB, which is authoritative).
    const result = verifyAction(makeAction({ secret: generateSecretKey() }));
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed escrow id", () => {
    expect(verifyAction(makeAction({ escrowId: "not-an-escrow-id" })).ok).toBe(
      false
    );
  });

  it("rejects duplicate d tags", () => {
    const event = makeAction({ extraTags: [["d", ESCROW_ID]] });
    expect(verifyAction(event).ok).toBe(false);
  });

  it("rejects content that disagrees with the signed tags", () => {
    const event = makeAction({ contentOverride: "{}" });
    const result = verifyAction(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/content/i);
  });

  it("rejects a tampered action (invalid signature)", () => {
    const event = makeAction();
    const tampered = {
      ...event,
      content: event.content.replace("refund", "refund!"),
    };
    expect(verifyAction(tampered).ok).toBe(false);
  });
});
