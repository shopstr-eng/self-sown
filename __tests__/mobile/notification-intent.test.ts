/** @jest-environment node */
import { resolveSellerNotificationIntent } from "../../apps/mobile/lib/notification-intent";
const payload = {
  version: 1,
  type: "seller_activity",
  activityId: "60c6f74b-9ce0-4dad-a888-1d9ac30f035b",
};
function deps() {
  return {
    lookup: jest.fn(async () => ({ messageId: "wrapped" })),
    loadOrders: jest.fn(async () => [
      { orderId: "order-1", wrappedEventIds: ["wrapped"] },
    ]),
    isCurrent: () => true,
  };
}
test("signed out preserves only opaque activity and performs no lookup", async () => {
  const d = deps();
  expect(await resolveSellerNotificationIntent(payload, false, d)).toEqual({
    kind: "sign_in",
    activityId: payload.activityId,
  });
  expect(d.lookup).not.toHaveBeenCalled();
});
test("opens an order only after authorized lookup and validated order loading", async () => {
  const d = deps();
  expect(await resolveSellerNotificationIntent(payload, true, d)).toEqual({
    kind: "order",
    orderId: "order-1",
  });
});
test("a session change while loading drops the intent", async () => {
  const d = deps();
  d.loadOrders.mockImplementation(async () => {
    d.isCurrent = () => false;
    return [];
  });
  expect(await resolveSellerNotificationIntent(payload, true, d)).toEqual({
    kind: "ignore",
  });
});
test("unmapped or ambiguous activity goes to the inbox", async () => {
  const d = deps();
  d.loadOrders.mockResolvedValue([
    { orderId: "one", wrappedEventIds: ["wrapped"] },
    { orderId: "two", wrappedEventIds: ["wrapped"] },
  ]);
  expect(await resolveSellerNotificationIntent(payload, true, d)).toEqual({
    kind: "inbox",
  });
});
test("payload URLs are rejected before any network access", async () => {
  const d = deps();
  expect(
    await resolveSellerNotificationIntent(
      { ...payload, url: "https://example.com" },
      true,
      d
    )
  ).toEqual({ kind: "ignore" });
  expect(d.lookup).not.toHaveBeenCalled();
});
