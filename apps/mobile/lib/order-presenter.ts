import {
  getNextSellerOrderStatus,
  type SellerOrder,
  type SellerOrderStatus,
} from "@milk-market/domain";

export type SellerOrderFilter = "all" | SellerOrderStatus;

const STATUS_LABELS: Record<SellerOrderStatus, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  shipped: "Shipped",
  completed: "Completed",
  canceled: "Canceled",
};

const ACTION_LABELS: Partial<Record<SellerOrderStatus, string>> = {
  confirmed: "Confirm order",
  shipped: "Mark as shipped",
  completed: "Mark as completed",
};

export function getSellerOrderStatusLabel(status: SellerOrderStatus): string {
  return STATUS_LABELS[status];
}

export function getSellerOrderActionLabel(
  status: SellerOrderStatus
): string | null {
  const nextStatus = getNextSellerOrderStatus(status);
  return nextStatus ? (ACTION_LABELS[nextStatus] ?? null) : null;
}

export function filterSellerOrders(
  orders: SellerOrder[],
  filter: SellerOrderFilter
): SellerOrder[] {
  return orders
    .filter((order) => filter === "all" || order.status === filter)
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        left.orderId.localeCompare(right.orderId)
    );
}

export function formatSellerOrderAmount(input: {
  amount?: number;
  currency?: string;
}): string {
  if (
    input.amount === undefined ||
    !Number.isFinite(input.amount) ||
    input.amount < 0
  ) {
    return "Amount unavailable";
  }

  const currency = input.currency?.trim().toUpperCase();
  if (currency === "SATS" || currency === "SAT") {
    return `${new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 0,
    }).format(input.amount)} sats`;
  }
  if (!currency) {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 2,
    }).format(input.amount);
  }
  return `${currency} ${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(input.amount)}`;
}

export function getSellerOrderBuyerLabel(input: {
  buyerEmail?: string;
  contact?: string;
  isGuest?: boolean;
  buyerPubkey?: string;
}): string {
  if (input.buyerEmail) return input.buyerEmail;
  if (input.contact) return input.contact;
  if (input.isGuest) return "Guest buyer";
  if (input.buyerPubkey) return `${input.buyerPubkey.slice(0, 12)}…`;
  return "Buyer unavailable";
}
