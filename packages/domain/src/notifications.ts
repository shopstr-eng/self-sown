export type MobilePushPlatform = "ios" | "android";
export interface SellerActivityPayload {
  version: 1;
  type: "seller_activity";
  activityId: string;
}
export type PushPermissionState =
  | "not_requested"
  | "enabled"
  | "disabled"
  | "os_denied"
  | "registration_pending"
  | "registration_failed";
export type NotificationOpenDecision =
  | { kind: "ignore" }
  | { kind: "sign_in"; activityId: string }
  | { kind: "inbox" }
  | { kind: "order"; orderId: string };
export interface NotificationDeviceChallengeInput {
  installationId: string;
  token: string;
  platform: MobilePushPlatform;
}
export interface NotificationDeviceConfirmationInput {
  installationId: string;
  challengeId: string;
  nonce: string;
}
export interface NotificationRegistration {
  deviceId: string;
  enabled: boolean;
  generation: number;
  revocationCapability: string;
}
export interface NotificationDeviceSummary {
  deviceId: string;
  platform: MobilePushPlatform;
  enabled: boolean;
  lastSeenAt: string;
}
export interface SellerActivityLookup {
  messageId: string;
}

export function isMobileNotificationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}
export function isMobilePushToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    /^(ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]+\]$/.test(value)
  );
}
export function isNotificationCapability(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
export function parseSellerActivityPayload(
  value: unknown
): SellerActivityPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 3 ||
    input.version !== 1 ||
    input.type !== "seller_activity" ||
    !isMobileNotificationId(input.activityId)
  )
    return null;
  return { version: 1, type: "seller_activity", activityId: input.activityId };
}
export function resolveNotificationOpen(input: {
  payload: SellerActivityPayload;
  signedIn: boolean;
  authorized: boolean;
  matchingValidatedOrderIds: readonly string[];
}): NotificationOpenDecision {
  const payload = parseSellerActivityPayload(input.payload);
  if (!payload) return { kind: "ignore" };
  if (!input.signedIn)
    return { kind: "sign_in", activityId: payload.activityId };
  if (!input.authorized) return { kind: "ignore" };
  const ids = [...new Set(input.matchingValidatedOrderIds)];
  const orderId = ids[0];
  if (ids.length !== 1 || !orderId || !/^[A-Za-z0-9._:-]{1,128}$/.test(orderId))
    return { kind: "inbox" };
  return { kind: "order", orderId };
}
