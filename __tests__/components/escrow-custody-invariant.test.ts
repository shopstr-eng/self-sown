/**
 * Source invariant: escrow custody at checkout.
 *
 * When a buyer opts into escrow, the locked P2PK proofs MUST stay with the
 * buyer — the lock's primary key is the seller's, so any message/receipt
 * that carries the token (or types it "ecash") hands the seller the funds
 * before expiry. Every sendPaymentAndContactMessage* call site and every
 * payment-tag entry in BOTH invoice cards must therefore carry the escrow
 * conditional ("escrow" type + escrow id, no token). A completion review
 * caught the N/A-Pickup buyer receipt leaking the token as plain "ecash"
 * after the other branches were converted — this test pins every shipping
 * branch of both cards.
 */
import { readFileSync } from "fs";
import { join } from "path";

const PRODUCT_CARD = "components/product-invoice-card.tsx";
const CART_CARD = "components/cart-invoice-card.tsx";

function readSource(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8");
}

describe("escrow custody invariant", () => {
  it.each([PRODUCT_CARD, CART_CARD])(
    "%s: every token-bearing send call carries the escrow conditional",
    (file) => {
      const src = readSource(file);
      const blocks = src
        .split(
          /sendPaymentAndContactMessage(?:WithPaymentPreference|WithKeys)?\(/
        )
        .slice(1);
      expect(blocks.length).toBeGreaterThan(0);
      let tokenBearing = 0;
      for (const raw of blocks) {
        // A call's argument list is well under this bound.
        const block = raw.slice(0, 2000);
        if (/sellerToken/i.test(block)) {
          tokenBearing += 1;
          expect(block).toContain('"escrow"');
        }
      }
      // Guards against the matcher silently matching nothing after a rename.
      expect(tokenBearing).toBeGreaterThan(0);
    }
  );

  it.each([PRODUCT_CARD, CART_CARD])(
    "%s: escrow message text never embeds the token",
    (file) => {
      const src = readSource(file);
      const indices = [
        ...src.matchAll(/This is an escrowed Cashu payment/g),
      ].map((m) => m.index!);
      expect(indices.length).toBeGreaterThan(0);
      for (const index of indices) {
        const tail = src.slice(index);
        // Bound the segment at the start of the non-escrow sibling branch.
        const end = tail.indexOf("This is a Cashu token");
        const segment = end === -1 ? tail.slice(0, 600) : tail.slice(0, end);
        expect(segment).not.toMatch(/sellerToken/i);
      }
    }
  );

  it("product card: no fixed-type ecash call passes the token directly", () => {
    const src = readSource(PRODUCT_CARD);
    // The leak signature from the N/A-Pickup receipt bug.
    expect(src).not.toMatch(/"ecash",\s*mints\[0\][^,]*,\s*sellerToken/s);
    // Seller message + every buyer receipt branch must be escrow-conditional.
    expect(
      src.match(/escrowActive \? "escrow" : "ecash"/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(4);
  });

  it("cart card: payment tag and seller send are escrow-conditional", () => {
    const src = readSource(CART_CARD);
    // Payment tag carries the escrow id instead of the token under escrow.
    expect(src).toContain('["payment", "escrow", productEscrowId]');
    // Seller send call: type and reference are both escrow-conditional.
    expect(src).toContain('productEscrowId ? "escrow" : "ecash"');
    expect(src).toContain("productEscrowId ? productEscrowId : sellerToken");
  });
});
