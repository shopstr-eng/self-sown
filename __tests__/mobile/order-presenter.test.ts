/** @jest-environment node */

import {
  filterSellerOrders,
  formatSellerOrderAmount,
  getSellerOrderActionLabel,
  getSellerOrderBuyerLabel,
  getSellerOrderStatusLabel,
  type SellerOrderFilter,
} from "../../apps/mobile/lib/order-presenter";
import type { SellerOrder } from "@milk-market/domain";

function makeOrder(
  orderId: string,
  status: SellerOrder["status"],
  updatedAt: number
): SellerOrder {
  const sellerPubkey = "a".repeat(64);
  return {
    orderId,
    subject: "order-info",
    sellerPubkey,
    isGuest: true,
    productAddress: `30402:${sellerPubkey}:milk`,
    quantity: 1,
    status,
    createdAt: updatedAt,
    updatedAt,
    unread: false,
    sourceEventIds: ["1".repeat(64)],
    wrappedEventIds: ["2".repeat(64)],
    history: [],
  };
}

describe("seller order presentation", () => {
  it.each<[SellerOrder["status"], string]>([
    ["pending", "Pending"],
    ["confirmed", "Confirmed"],
    ["shipped", "Shipped"],
    ["completed", "Completed"],
    ["canceled", "Canceled"],
  ])("labels %s status", (status, label) => {
    expect(getSellerOrderStatusLabel(status)).toBe(label);
  });

  it.each([
    ["pending", "Confirm order"],
    ["confirmed", "Mark as shipped"],
    ["shipped", "Mark as completed"],
    ["completed", null],
    ["canceled", null],
  ] as const)("selects the action for %s", (status, label) => {
    expect(getSellerOrderActionLabel(status)).toBe(label);
  });

  it("filters by status and always returns newest orders first", () => {
    const orders = [
      makeOrder("old-pending", "pending", 10),
      makeOrder("completed", "completed", 30),
      makeOrder("new-pending", "pending", 20),
    ];

    expect(
      filterSellerOrders(orders, "all").map((order) => order.orderId)
    ).toEqual(["completed", "new-pending", "old-pending"]);
    expect(
      filterSellerOrders(orders, "pending").map((order) => order.orderId)
    ).toEqual(["new-pending", "old-pending"]);
    expect(filterSellerOrders(orders, "shipped" as SellerOrderFilter)).toEqual(
      []
    );
  });

  it("formats bounded order amounts without inventing a currency", () => {
    expect(formatSellerOrderAmount({ amount: 24.5, currency: "USD" })).toBe(
      "USD 24.50"
    );
    expect(formatSellerOrderAmount({ amount: 1500, currency: "SATS" })).toBe(
      "1,500 sats"
    );
    expect(formatSellerOrderAmount({})).toBe("Amount unavailable");
  });

  it("uses the safest available buyer label for the inbox", () => {
    expect(getSellerOrderBuyerLabel({ buyerEmail: "buyer@example.com" })).toBe(
      "buyer@example.com"
    );
    expect(getSellerOrderBuyerLabel({ contact: "+91 98765 43210" })).toBe(
      "+91 98765 43210"
    );
    expect(getSellerOrderBuyerLabel({ isGuest: true })).toBe("Guest buyer");
    expect(getSellerOrderBuyerLabel({ buyerPubkey: "b".repeat(64) })).toBe(
      `${"b".repeat(12)}…`
    );
    expect(getSellerOrderBuyerLabel({})).toBe("Buyer unavailable");
  });
});
