import { getSellerFulfillmentActions } from "@/utils/orders/seller-fulfillment-actions";

test("pending sellers must confirm before fulfillment actions are available", () => {
  expect(
    getSellerFulfillmentActions({
      isSale: true,
      status: "pending",
      canBuyLabel: true,
    })
  ).toEqual({
    canConfirm: true,
    canSendShippingUpdate: false,
    canBuyOutboundLabel: false,
  });
});

test("confirmed sellers can buy a label and send the shipping update", () => {
  expect(
    getSellerFulfillmentActions({
      isSale: true,
      status: "confirmed",
      canBuyLabel: true,
    })
  ).toEqual({
    canConfirm: false,
    canSendShippingUpdate: true,
    canBuyOutboundLabel: true,
  });
});

test("non-sale and completed orders expose no outbound fulfillment actions", () => {
  expect(
    getSellerFulfillmentActions({
      isSale: false,
      status: "confirmed",
      canBuyLabel: true,
    })
  ).toEqual({
    canConfirm: false,
    canSendShippingUpdate: false,
    canBuyOutboundLabel: false,
  });
  expect(
    getSellerFulfillmentActions({
      isSale: true,
      status: "completed",
      canBuyLabel: true,
    })
  ).toEqual({
    canConfirm: false,
    canSendShippingUpdate: false,
    canBuyOutboundLabel: false,
  });
});
