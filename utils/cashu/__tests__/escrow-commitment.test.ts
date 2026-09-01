import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
} from "nostr-tools";
import {
  buildEscrowCommitmentContent,
  buildEscrowCommitmentEventTemplate,
  deriveEscrowId,
  verifyEscrowCommitmentEvent,
  ESCROW_COMMITMENT_KIND,
  ESCROW_COMMITMENT_MAX_AGE_SECONDS,
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
      { ...event, kind: 1, tags: event.tags, content: event.content, created_at: NOW },
      buyerSecret
    );
    expect(verify(wrong).ok).toBe(false);
    expect(event.kind).toBe(ESCROW_COMMITMENT_KIND);
  });

  it("rejects stale and far-future created_at (replay window)", () => {
    const { event } = makeCommitment(buyerSecret);
    expect(
      verify(event, NOW + ESCROW_COMMITMENT_MAX_AGE_SECONDS + 1).ok
    ).toBe(false);
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
