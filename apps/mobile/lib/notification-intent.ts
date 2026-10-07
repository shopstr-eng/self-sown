import {
  parseSellerActivityPayload,
  resolveNotificationOpen,
  type NotificationOpenDecision,
} from "@self-sown/domain";
export async function resolveSellerNotificationIntent(
  value: unknown,
  signedIn: boolean,
  deps: {
    lookup: (activityId: string) => Promise<{ messageId: string }>;
    loadOrders: () => Promise<
      readonly { orderId: string; wrappedEventIds: readonly string[] }[]
    >;
    isCurrent: () => boolean;
  }
): Promise<NotificationOpenDecision> {
  const payload = parseSellerActivityPayload(value);
  if (!payload) return { kind: "ignore" };
  if (!signedIn) return { kind: "sign_in", activityId: payload.activityId };
  const activity = await deps.lookup(payload.activityId);
  if (!deps.isCurrent()) return { kind: "ignore" };
  const orders = await deps.loadOrders();
  if (!deps.isCurrent()) return { kind: "ignore" };
  return resolveNotificationOpen({
    payload,
    signedIn: true,
    authorized: true,
    matchingValidatedOrderIds: orders
      .filter((o) => o.wrappedEventIds.includes(activity.messageId))
      .map((o) => o.orderId),
  });
}
