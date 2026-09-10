import type { SellerOrderStatus } from "@self-sown/domain";

import { StatusPill } from "@/components/seller-ui";
import { getSellerOrderStatusLabel } from "@/lib/order-presenter";

export function OrderStatusBadge({ status }: { status: SellerOrderStatus }) {
  const tone =
    status === "completed"
      ? "success"
      : status === "canceled"
        ? "danger"
        : status === "pending" || status === "shipped"
          ? "warning"
          : "neutral";

  return <StatusPill tone={tone} label={getSellerOrderStatusLabel(status)} />;
}
