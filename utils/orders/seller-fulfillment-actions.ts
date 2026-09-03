export interface SellerFulfillmentActions {
  canConfirm: boolean;
  canSendShippingUpdate: boolean;
  canBuyOutboundLabel: boolean;
}

export function getSellerFulfillmentActions({
  isSale,
  status,
  canBuyLabel,
}: {
  isSale: boolean;
  status: string;
  canBuyLabel: boolean;
}): SellerFulfillmentActions {
  if (!isSale) {
    return {
      canConfirm: false,
      canSendShippingUpdate: false,
      canBuyOutboundLabel: false,
    };
  }

  return {
    canConfirm: status === "pending",
    canSendShippingUpdate: status === "confirmed",
    canBuyOutboundLabel: status === "confirmed" && canBuyLabel,
  };
}
