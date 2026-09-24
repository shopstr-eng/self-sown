/** @jest-environment node */

const buyLabelMock = jest.fn();
const isDefinitiveShippoPurchaseFailureMock = jest.fn();
const claimOutboundLabelPurchaseMock = jest.fn();
const releaseOutboundLabelClaimMock = jest.fn();
const markOutboundLabelPurchasedMock = jest.fn();
const claimShipmentForPurchaseMock = jest.fn();
const releaseShipmentClaimMock = jest.fn();
const insertShippingLabelMock = jest.fn();

jest.mock("@/utils/shipping/shippo", () => ({
  buyLabel: (...args: unknown[]) => buyLabelMock(...args),
  isDefinitiveShippoPurchaseFailure: (...args: unknown[]) =>
    isDefinitiveShippoPurchaseFailureMock(...args),
}));

jest.mock("@/utils/db/shipping-service", () => ({
  claimOutboundLabelPurchase: (...args: unknown[]) =>
    claimOutboundLabelPurchaseMock(...args),
  releaseOutboundLabelClaim: (...args: unknown[]) =>
    releaseOutboundLabelClaimMock(...args),
  markOutboundLabelPurchased: (...args: unknown[]) =>
    markOutboundLabelPurchasedMock(...args),
  claimShipmentForPurchase: (...args: unknown[]) =>
    claimShipmentForPurchaseMock(...args),
  releaseShipmentClaim: (...args: unknown[]) =>
    releaseShipmentClaimMock(...args),
  insertShippingLabel: (...args: unknown[]) => insertShippingLabelMock(...args),
}));

import { purchaseOutboundLabel } from "@/utils/shipping/outbound-label-purchase";

const input = {
  sellerPubkey: "a".repeat(64),
  orderId: "order-1",
  accessToken: "oauth.seller",
  shipmentId: "ship-1",
  rateId: "rate-1",
  claimShipment: true,
};

const label = {
  shipmentId: "ship-1",
  trackingCode: "TRACK-1",
  trackingUrl: null,
  labelUrl: "https://labels.example/1.pdf",
  labelFormat: "PDF",
  rate: 8.25,
  currency: "USD",
  carrier: "USPS",
  service: "Priority",
};

beforeEach(() => {
  jest.clearAllMocks();
  claimOutboundLabelPurchaseMock.mockResolvedValue(true);
  claimShipmentForPurchaseMock.mockResolvedValue(true);
  buyLabelMock.mockResolvedValue(label);
  markOutboundLabelPurchasedMock.mockResolvedValue(undefined);
  insertShippingLabelMock.mockResolvedValue({ id: 42 });
  isDefinitiveShippoPurchaseFailureMock.mockReturnValue(false);
});

test("claims before charging and records one purchased label", async () => {
  await expect(purchaseOutboundLabel(input)).resolves.toEqual({
    status: "purchased",
    label,
    labelId: 42,
  });

  expect(claimOutboundLabelPurchaseMock).toHaveBeenCalledWith(
    input.sellerPubkey,
    input.orderId
  );
  expect(claimShipmentForPurchaseMock).toHaveBeenCalledWith(
    input.shipmentId,
    input.sellerPubkey,
    input.orderId
  );
  expect(buyLabelMock).toHaveBeenCalledTimes(1);
  expect(markOutboundLabelPurchasedMock).toHaveBeenCalledWith(
    input.sellerPubkey,
    input.orderId,
    input.shipmentId
  );
  expect(insertShippingLabelMock).toHaveBeenCalledTimes(1);
});

test("does not charge when another flow already claimed the order", async () => {
  claimOutboundLabelPurchaseMock.mockResolvedValue(false);

  await expect(purchaseOutboundLabel(input)).resolves.toEqual({
    status: "order-already-claimed",
  });
  expect(claimShipmentForPurchaseMock).not.toHaveBeenCalled();
  expect(buyLabelMock).not.toHaveBeenCalled();
});

test("releases the order claim when the shipment claim is unavailable", async () => {
  claimShipmentForPurchaseMock.mockResolvedValue(false);

  await expect(purchaseOutboundLabel(input)).resolves.toEqual({
    status: "shipment-already-claimed",
  });
  expect(releaseOutboundLabelClaimMock).toHaveBeenCalledWith(
    input.sellerPubkey,
    input.orderId
  );
  expect(buyLabelMock).not.toHaveBeenCalled();
});

test("releases claims after a definitive provider rejection", async () => {
  const error = new Error("rate rejected");
  buyLabelMock.mockRejectedValue(error);
  isDefinitiveShippoPurchaseFailureMock.mockReturnValue(true);

  await expect(purchaseOutboundLabel(input)).rejects.toBe(error);
  expect(releaseShipmentClaimMock).toHaveBeenCalledWith(input.shipmentId);
  expect(releaseOutboundLabelClaimMock).toHaveBeenCalledWith(
    input.sellerPubkey,
    input.orderId
  );
});

test("retains both claims when the provider outcome is uncertain", async () => {
  buyLabelMock.mockRejectedValue(new Error("timeout"));

  await expect(purchaseOutboundLabel(input)).resolves.toEqual({
    status: "uncertain",
  });
  expect(releaseShipmentClaimMock).not.toHaveBeenCalled();
  expect(releaseOutboundLabelClaimMock).not.toHaveBeenCalled();
});

test("never reopens the claim after a charge when persistence fails", async () => {
  markOutboundLabelPurchasedMock.mockRejectedValue(new Error("db down"));
  insertShippingLabelMock.mockRejectedValue(new Error("db down"));

  await expect(purchaseOutboundLabel(input)).resolves.toEqual({
    status: "purchased",
    label,
    labelId: null,
  });
  expect(releaseShipmentClaimMock).not.toHaveBeenCalled();
  expect(releaseOutboundLabelClaimMock).not.toHaveBeenCalled();
});
