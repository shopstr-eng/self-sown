import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

/**
 * Apple Tap to Pay requirement 5.12: when a card payment ends not approved and
 * the seller backgrounded (or closed) the app before seeing the result, they
 * must still learn the outcome. A local notification fires immediately; the
 * app's foreground handler suppresses the banner in-app, so it only surfaces
 * as a system notification when the seller isn't looking at the screen.
 *
 * Best-effort by contract: a permission denial or native failure must never
 * mask the on-screen error, so this resolves quietly in every failure mode.
 */
export async function notifyCardPaymentNotApproved(input: {
  amountText: string;
}): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("seller-activity", {
        name: "Seller activity",
        importance: Notifications.AndroidImportance.DEFAULT,
        lockscreenVisibility:
          Notifications.AndroidNotificationVisibility.PRIVATE,
      });
    }
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) {
      permission = await Notifications.requestPermissionsAsync();
    }
    if (!permission.granted) return;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Card payment not approved",
        body: `The ${input.amountText} card payment was declined or did not complete. No charge was made.`,
        ...(Platform.OS === "android" ? { channelId: "seller-activity" } : {}),
      },
      trigger: null,
    });
  } catch {
    // Courtesy notification only — the on-screen result is authoritative.
  }
}
