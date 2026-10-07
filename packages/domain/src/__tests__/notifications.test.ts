import { parseSellerActivityPayload, resolveNotificationOpen } from "../index";

const activityId = "123e4567-e89b-42d3-a456-426614174000";
const payload = {
  version: 1 as const,
  type: "seller_activity" as const,
  activityId,
};

describe("seller notification intents", () => {
  test("accepts only the versioned opaque activity payload", () => {
    expect(parseSellerActivityPayload(payload)).toEqual(payload);
  });
  test.each([
    null,
    [],
    {},
    { ...payload, version: 2 },
    { ...payload, type: "device_challenge" },
    { ...payload, activityId: "../orders/private" },
    { ...payload, activityId: "not-a-uuid" },
    { ...payload, url: "https://example.com" },
    { ...payload, orderId: "claimed-order" },
    { ...payload, buyer: "private-data" },
  ])("rejects malformed or expanded payload %j", (value) => {
    expect(parseSellerActivityPayload(value)).toBeNull();
  });
  test("waits for authentication without exposing an order identifier", () => {
    expect(
      resolveNotificationOpen({
        payload,
        signedIn: false,
        authorized: false,
        matchingValidatedOrderIds: ["private-order"],
      })
    ).toEqual({ kind: "sign_in", activityId });
  });
  test("ignores another account activity even when supplied an order match", () => {
    expect(
      resolveNotificationOpen({
        payload,
        signedIn: true,
        authorized: false,
        matchingValidatedOrderIds: ["private-order"],
      })
    ).toEqual({ kind: "ignore" });
  });
  test.each([[[]], [["a", "b"]], [["../settings"]]])(
    "falls back to inbox for unsafe or ambiguous matches %j",
    (ids) => {
      expect(
        resolveNotificationOpen({
          payload,
          signedIn: true,
          authorized: true,
          matchingValidatedOrderIds: ids,
        })
      ).toEqual({ kind: "inbox" });
    }
  );
  test("opens exactly one validated order", () => {
    expect(
      resolveNotificationOpen({
        payload,
        signedIn: true,
        authorized: true,
        matchingValidatedOrderIds: ["order-1", "order-1"],
      })
    ).toEqual({ kind: "order", orderId: "order-1" });
  });
});
