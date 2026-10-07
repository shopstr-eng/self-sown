import { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import type { NotificationDeviceSummary } from "@self-sown/domain";
import { ActionButton, SellerCard } from "./seller-ui";
import {
  authorizeNotifications,
  deviceRegistration,
  disableSellerAlerts,
  enableSellerAlerts,
  notificationApi,
  notificationAvailability,
  refreshNotificationState,
  useNotificationState,
} from "../lib/notification-runtime";
import { useSessionStore } from "../stores/session-store";
export function NotificationSettings() {
  const { enabled, busy, message, pendingRevocation, revision } =
    useNotificationState();
  const session = useSessionStore((state) => state.session);
  const [devices, setDevices] = useState<NotificationDeviceSummary[]>([]);
  const [deviceMessage, setDeviceMessage] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    void refreshNotificationState().catch(() => {});
  }, []);
  useEffect(() => {
    let current = true;
    setDevices([]);
    if (session)
      void notificationApi
        .listDevices({ authorize: authorizeNotifications(session) })
        .then((rows) => {
          if (current) {
            setDevices(rows);
            setDeviceMessage("");
          }
        })
        .catch(() => {
          if (current)
            setDeviceMessage("Registered devices could not be loaded.");
        });
    return () => {
      current = false;
    };
  }, [session, revision, refresh]);
  async function revoke(id: string) {
    if (!session) return;
    try {
      const local = await deviceRegistration.read();
      if (local.active?.deviceId === id) await disableSellerAlerts();
      else
        await notificationApi.revokeDevice(id, {
          authorize: authorizeNotifications(session),
        });
      setRefresh((value) => value + 1);
    } catch {
      setDeviceMessage("Device could not be revoked. Reconnect and retry.");
    }
  }
  const unavailable = notificationAvailability();
  return (
    <SellerCard
      title="Seller activity alerts"
      description="Get a private reminder when this server receives new seller messages. Open Orders to verify the latest details."
    >
      <Text accessibilityLiveRegion="polite">
        {enabled ? "Enabled on this device" : "Off on this device"}
      </Text>
      <Text>{unavailable || message}</Text>
      {pendingRevocation ? (
        <Text>
          Server revocation is pending. Reconnect to finish turning off
          delivery.
        </Text>
      ) : null}
      <ActionButton
        label={enabled ? "Turn off alerts" : "Enable alerts"}
        loading={busy}
        disabled={!enabled && !!unavailable}
        onPress={
          enabled
            ? () => {
                void disableSellerAlerts().catch(() =>
                  setDeviceMessage(
                    "Device settings could not be saved. Retry turning off alerts."
                  )
                );
              }
            : enableSellerAlerts
        }
      />
      <ActionButton
        label="Open notification settings"
        variant="secondary"
        onPress={() => {
          void Linking.openSettings();
        }}
      />
      {devices
        .filter((device) => device.enabled)
        .map((device) => (
          <View key={device.deviceId}>
            <Text>
              {device.platform === "ios" ? "iPhone / iPad" : "Android"} · Last
              active {new Date(device.lastSeenAt).toLocaleDateString()}
            </Text>
            <ActionButton
              label="Revoke device"
              variant="secondary"
              onPress={() => {
                void revoke(device.deviceId);
              }}
            />
          </View>
        ))}
      {deviceMessage ? (
        <>
          <Text>{deviceMessage}</Text>
          <ActionButton
            label="Retry device list"
            variant="secondary"
            onPress={() => setRefresh((value) => value + 1)}
          />
        </>
      ) : null}
    </SellerCard>
  );
}
