import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { create } from "zustand";
import {
  createSellerNotificationApiClient,
  SellerNotificationApiError,
} from "@self-sown/api-client";
import { createNip98AuthorizationHeader } from "@self-sown/nostr";
import {
  isMobileNotificationId,
  isNotificationCapability,
  type SellerSession,
} from "@self-sown/domain";
import { getApiBaseUrl } from "./api-base-url";
import { createDeviceRegistrationController } from "./notification-registration";
import { setBeforeSellerSessionChange } from "./session-lifecycle";
import { useSessionStore } from "../stores/session-store";

const baseUrl = getApiBaseUrl();
export const notificationApi = createSellerNotificationApiClient({ baseUrl });
const storageKey = `self-sown-push-${encodeURIComponent(baseUrl).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
export const useNotificationState = create<{
  enabled: boolean;
  pendingRevocation: boolean;
  busy: boolean;
  message: string;
  revision: number;
}>(() => ({
  enabled: false,
  pendingRevocation: false,
  busy: false,
  message: "Alerts are off.",
  revision: 0,
}));
export function authorizeNotifications(session: SellerSession) {
  return ({
    path,
    method,
    body,
  }: {
    path: string;
    method: "GET" | "POST" | "DELETE";
    body?: string;
  }) =>
    createNip98AuthorizationHeader({
      session,
      url: `${baseUrl}${path}`,
      method,
      body,
    });
}
const challenges = new Map<string, { nonce: string; at: number }>();
const waiters = new Map<string, (nonce: string) => void>();
let nativeToken: Notifications.DevicePushToken | undefined;
export function receiveDeviceChallenge(data: unknown) {
  if (!data || typeof data !== "object") return;
  const item = data as Record<string, unknown>;
  if (
    item.type !== "device_challenge" ||
    item.version !== 1 ||
    !isMobileNotificationId(item.challengeId) ||
    !isNotificationCapability(item.nonce)
  )
    return;
  if (challenges.size >= 10) challenges.clear();
  challenges.set(item.challengeId, { nonce: item.nonce, at: Date.now() });
  waiters.get(item.challengeId)?.(item.nonce);
}
async function waitForChallenge(id: string) {
  const early = challenges.get(id);
  if (early && Date.now() - early.at < 60000) {
    challenges.delete(id);
    return early.nonce;
  }
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      waiters.delete(id);
      reject(
        new Error("Device verification timed out. Keep the app open and retry.")
      );
    }, 45000);
    waiters.set(id, (nonce) => {
      clearTimeout(timeout);
      waiters.delete(id);
      challenges.delete(id);
      resolve(nonce);
    });
  });
}
export function notificationAvailability(): string | null {
  if (Platform.OS === "web")
    return "Push alerts are available in the iOS and Android apps.";
  if (!Device.isDevice)
    return "Push registration requires a physical device. Orders can still be refreshed here.";
  if (Constants.appOwnership === "expo")
    return "Push alerts require an installed development or beta build.";
  if (
    !isMobileNotificationId(
      Constants.expoConfig?.extra?.eas?.projectId ??
        Constants.easConfig?.projectId
    )
  )
    return "Push alerts are not configured for this build.";
  return null;
}
export const deviceRegistration = createDeviceRegistrationController({
  read: () => SecureStore.getItemAsync(storageKey),
  write: (value) =>
    SecureStore.setItemAsync(storageKey, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  randomId: Crypto.randomUUID,
  register: async (installationId, seller) => {
    const session = useSessionStore.getState().session;
    if (!session || session.pubkey !== seller)
      throw new Error("Sign in again to enable alerts.");
    const unavailable = notificationAvailability();
    if (unavailable) throw new Error(unavailable);
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted)
      throw new Error(
        "Allow notifications in system settings to enable alerts."
      );
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    const token = (
      await Notifications.getExpoPushTokenAsync({
        projectId,
        devicePushToken: nativeToken,
      })
    ).data;
    const authorize = authorizeNotifications(session);
    const challenge = await notificationApi.requestChallenge(
      {
        installationId,
        token,
        platform: Platform.OS === "ios" ? "ios" : "android",
      },
      { authorize }
    );
    const nonce = await waitForChallenge(challenge.challengeId);
    if (useSessionStore.getState().session?.pubkey !== seller)
      throw new Error("Seller account changed.");
    return notificationApi.confirmDevice(
      { installationId, challengeId: challenge.challengeId, nonce },
      { authorize }
    );
  },
  revoke: async (device) => {
    try {
      await notificationApi.revokeDevice(device.deviceId, {
        revocationCapability: device.revocationCapability,
      });
    } catch (error) {
      if (error instanceof SellerNotificationApiError && error.status === 404)
        return;
      throw error;
    }
  },
  onChange: () => {
    void refreshNotificationState();
  },
});
export async function refreshNotificationState() {
  const record = await deviceRegistration.read();
  const seller = useSessionStore.getState().session?.pubkey;
  const enabled =
    !!record.active &&
    record.active.seller === seller &&
    record.enabledFor === seller;
  useNotificationState.setState((s) => ({
    enabled,
    pendingRevocation: record.pending.length > 0,
    revision: s.revision + 1,
  }));
}
export async function enableSellerAlerts() {
  useNotificationState.setState({ busy: true, message: "" });
  try {
    const unavailable = notificationAvailability();
    if (unavailable) throw new Error(unavailable);
    const seller = useSessionStore.getState().session?.pubkey;
    if (!seller) throw new Error("Sign in to enable alerts.");
    if (Platform.OS === "android")
      await Notifications.setNotificationChannelAsync("seller-activity", {
        name: "Seller activity",
        importance: Notifications.AndroidImportance.DEFAULT,
        lockscreenVisibility:
          Notifications.AndroidNotificationVisibility.PRIVATE,
      });
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain)
      permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted)
      throw new Error(
        "Notifications are denied. You can allow them in system settings."
      );
    if (useSessionStore.getState().session?.pubkey !== seller)
      throw new Error(
        "Seller account changed. Enable alerts after signing in again."
      );
    await deviceRegistration.enable(seller);
    const record = await deviceRegistration.read();
    if (
      useSessionStore.getState().session?.pubkey !== seller ||
      record.active?.seller !== seller ||
      record.enabledFor !== seller
    )
      return;
    useNotificationState.setState({
      message: "Seller activity alerts are enabled on this device.",
    });
  } catch (error) {
    useNotificationState.setState({
      message:
        error instanceof SellerNotificationApiError
          ? "Alerts could not be enabled. Check your connection and retry."
          : error instanceof Error
            ? error.message
            : "Alerts could not be enabled.",
    });
  } finally {
    useNotificationState.setState({ busy: false });
    await refreshNotificationState();
  }
}
export async function disableSellerAlerts() {
  await deviceRegistration.disable();
  if (Platform.OS !== "web") await Notifications.dismissAllNotificationsAsync();
  useNotificationState.setState({
    message:
      "Alerts are off. Any pending server revocation will retry when connected.",
  });
  await deviceRegistration.flushRevocations();
  await refreshNotificationState();
}
let renewalAt = 0;
export async function reconcileSellerAlerts(force = false) {
  await deviceRegistration.flushRevocations();
  const seller = useSessionStore.getState().session?.pubkey;
  const record = await deviceRegistration.read();
  if (record.active && record.active.seller !== seller) {
    await deviceRegistration.disable();
    await deviceRegistration.flushRevocations();
  }
  if (seller && record.enabledFor === seller && !notificationAvailability()) {
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) {
      await disableSellerAlerts();
      return;
    }
    if (force || Date.now() - renewalAt > 86400000) {
      await deviceRegistration.renew(seller);
      renewalAt = Date.now();
    }
  }
  await refreshNotificationState();
}
export function handleNativeTokenChange(token: Notifications.DevicePushToken) {
  nativeToken = token;
  renewalAt = 0;
  void reconcileSellerAlerts(true).catch(() =>
    useNotificationState.setState({
      message: "Device registration needs a retry.",
    })
  );
}
setBeforeSellerSessionChange(async () => {
  renewalAt = 0;
  challenges.clear();
  if (Platform.OS !== "web")
    void Notifications.dismissAllNotificationsAsync().catch(() => {});
  await deviceRegistration.disable();
  void deviceRegistration.flushRevocations().catch(() => {});
  if (Platform.OS !== "web")
    void Notifications.clearLastNotificationResponseAsync().catch(() => {});
});
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    receiveDeviceChallenge(notification.request.content.data);
    const visible = false; // Foreground activity refreshes Orders without a system banner.
    return {
      shouldShowBanner: visible,
      shouldShowList: visible,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
});
