/**
 * Source-invariant guard for the buyer checkout Lightning/NWC invoice flows.
 *
 * WHY THIS EXISTS
 * `@cashu/cashu-ts` v4 requires `await wallet.loadMint()` before a freshly
 * constructed `CashuWallet` can call `createMintQuoteBolt11()`. Skipping it
 * throws at runtime ("Mint info not initialized; call loadMint or
 * loadMintFromCache first"), which the invoice-card handlers swallow into
 * `invoiceGenerationFailed` — so Bitcoin buyers just see "invoice failed" with
 * no invoice, for a perfectly valid price/currency.
 *
 * The existing cashu-api-contract test only asserts the library METHODS EXIST;
 * it cannot catch a checkout handler that forgets to CALL loadMint. This bug
 * reached production exactly that way. This test encodes the missing invariant:
 * in the buyer invoice cards, every `createMintQuoteBolt11(...)` call must be
 * preceded by a `loadMint()` on the wallet it was constructed from.
 */
import { readFileSync } from "fs";
import { join } from "path";

const INVOICE_CARDS = [
  "components/product-invoice-card.tsx",
  "components/cart-invoice-card.tsx",
];

describe("invoice-card wallet loadMint invariant", () => {
  it.each(INVOICE_CARDS)(
    "%s calls loadMint() before every createMintQuoteBolt11()",
    (relPath) => {
      const src = readFileSync(join(process.cwd(), relPath), "utf8");

      const quoteCalls = [...src.matchAll(/createMintQuoteBolt11\s*\(/g)];
      // Guard against the test silently passing if the method were renamed:
      // both cards drive at least the Lightning + NWC quote paths.
      expect(quoteCalls.length).toBeGreaterThanOrEqual(2);

      for (const match of quoteCalls) {
        const callIndex = match.index ?? 0;

        // Find the wallet this quote is created from: the nearest preceding
        // `new CashuWallet(` construction.
        const before = src.slice(0, callIndex);
        const walletIndex = before.lastIndexOf("new CashuWallet(");
        expect(walletIndex).toBeGreaterThanOrEqual(0);

        // Between constructing the wallet and requesting the quote there must
        // be a loadMint() call (the mandatory v4 mint-info bootstrap).
        const between = src.slice(walletIndex, callIndex);
        expect(between).toMatch(/\.loadMint\s*\(/);
      }
    }
  );
});
