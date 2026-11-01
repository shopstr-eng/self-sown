import { pricePosCartLine, type PosCartLine } from "@self-sown/domain";

import type { PosCompletedSale, PosReceiptLine } from "./pos-cart-store";
import { formatPosAmount } from "./pos-fx";

/**
 * Snapshot the cart as priced receipt lines. Must run before completeSale —
 * completing a sale clears the cart, and Apple Tap to Pay requirement 5.10
 * needs an itemized receipt shareable after the sale screen renders.
 */
export function buildPosReceiptLines(lines: PosCartLine[]): PosReceiptLine[] {
  return lines.map((line) => ({
    title: line.item.title,
    quantity: line.quantity,
    total: pricePosCartLine(line.item, line.quantity).total,
  }));
}

const METHOD_LABELS: Record<string, string> = {
  lightning: "Lightning (Bitcoin)",
  card: "Card",
  cash: "Cash / other",
};

/**
 * Plain-text itemized receipt for the system share sheet (SMS, email, AirDrop
 * — any Activity target), which satisfies the 5.10 "confidential digital
 * receipt" requirement without collecting buyer contact details.
 */
export function formatPosReceiptText(sale: PosCompletedSale): string {
  const rows = [
    "Sale receipt",
    "",
    ...sale.receiptLines.map(
      (line) =>
        `${line.title} × ${line.quantity} — ${formatPosAmount(line.total, sale.currency)}`
    ),
  ];
  if (sale.receiptLines.length === 0) {
    rows.push(`${sale.itemCount} item${sale.itemCount === 1 ? "" : "s"}`);
  }
  rows.push(
    "",
    `Total: ${formatPosAmount(sale.total, sale.currency)}`,
    `Paid by: ${METHOD_LABELS[sale.method] ?? sale.method}`
  );
  return rows.join("\n");
}

/**
 * Receipt for a card attempt that was NOT approved (5.10 covers declined
 * transactions too): it records the outcome and states no charge was made.
 */
export function formatDeclinedCardReceiptText(input: {
  total: number;
  currency: string;
}): string {
  return [
    "Card payment receipt",
    "",
    `Amount: ${formatPosAmount(input.total, input.currency)}`,
    "Result: not approved — no charge was made.",
  ].join("\n");
}
