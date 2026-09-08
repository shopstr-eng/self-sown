import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { focusManager, onlineManager } from "@tanstack/react-query";
import * as Network from "expo-network";
import * as Notifications from "expo-notifications";
import { useRootNavigationState, useRouter, type Href } from "expo-router";
import {
  parseSellerActivityPayload,
  type SellerActivityPayload,
} from "@self-sown/domain";
import { SellerNotificationApiError } from "@self-sown/api-client";
import { useSessionStore } from "../stores/session-store";
import { queryClient } from "../lib/query-client";
import { loadSellerOrders, sellerOrdersQueryKey } from "../lib/order-query";
import {
  retryPendingMobileSellerOrderNotifications,
  sellerOrdersLoaderDependencies,
} from "../lib/seller-order-runtime";
import { resolveSellerNotificationIntent } from "../lib/notification-intent";
import {
  authorizeNotifications,
  notificationApi,
  receiveDeviceChallenge,
  reconcileSellerAlerts,
  handleNativeTokenChange,
  useNotificationState,
} from "../lib/notification-runtime";

export function SellerActivityBridge() {
  const router = useRouter();
  const navigation = useRootNavigationState();
  const pending = useRef<{ payload: SellerActivityPayload; at: number } | null>(
    null
  );
  const seen = useRef(new Set<string>());
  const version = useRef(0);
  const opening = useRef(false);
  useEffect(() => {
    if (!navigation?.key) return;
    let active = true;
    let refreshRunning = false;
    async function openPending() {
      if (
        opening.current ||
        !pending.current ||
        !active ||
        AppState.currentState !== "active"
      )
        return;
      if (Date.now() - pending.current.at > 1800000) {
        pending.current = null;
        return;
      }
      const intent = pending.current;
      const session = useSessionStore.getState().session;
      const epoch = version.current;
      const isCurrent = () =>
        active &&
        version.current === epoch &&
        useSessionStore.getState().session?.pubkey === session?.pubkey;
      opening.current = true;
      try {
        const decision = await resolveSellerNotificationIntent(
          intent.payload,
          !!session,
          {
            isCurrent,
            lookup: (id) =>
              notificationApi.lookupActivity(id, {
                authorize: authorizeNotifications(session!),
              }),
            loadOrders: async () =>
              (await loadSellerOrders(session!, sellerOrdersLoaderDependencies))
                .orders,
          }
        );
        if (!isCurrent()) return;
        if (decision.kind === "sign_in") {
          router.replace("/sign-in" as Href);
          return;
        }
        if (pending.current === intent) pending.current = null;
        if (decision.kind === "order")
          router.push(
            {
              pathname: "/orders/[orderId]",
              params: { orderId: decision.orderId },
            } as Href,
            { withAnchor: true }
          );
        else if (decision.kind === "inbox") router.push("/orders" as Href);
      } catch (error) {
        if (!isCurrent()) return;
        if (
          error instanceof SellerNotificationApiError &&
          [401, 403, 404].includes(error.status)
        )
          pending.current = null;
        useNotificationState.setState({
          message:
            "This alert could not be opened. Refresh Orders to review current activity.",
        });
      } finally {
        opening.current = false;
      }
    }
    async function refresh() {
      if (refreshRunning || !active || AppState.currentState !== "active")
        return;
      refreshRunning = true;
      try {
        const session = useSessionStore.getState().session;
        await Promise.allSettled([
          reconcileSellerAlerts(),
          session
            ? queryClient.invalidateQueries({
                queryKey: sellerOrdersQueryKey(session.pubkey),
              })
            : Promise.resolve(),
          session
            ? retryPendingMobileSellerOrderNotifications(session)
            : Promise.resolve(),
          openPending(),
        ]);
      } finally {
        refreshRunning = false;
      }
    }
    function response(value: Notifications.NotificationResponse) {
      const id = value.notification.request.identifier;
      if (seen.current.has(id)) return;
      const payload = parseSellerActivityPayload(
        value.notification.request.content.data
      );
      if (!payload) return;
      if (seen.current.size > 100) seen.current.clear();
      seen.current.add(id);
      pending.current = { payload, at: Date.now() };
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
      void openPending();
    }
    const app = AppState.addEventListener("change", (state) => {
      focusManager.setFocused(state === "active");
      if (state === "active") void refresh();
    });
    const net = Network.addNetworkStateListener((state) => {
      const online =
        state.isConnected !== false && state.isInternetReachable !== false;
      onlineManager.setOnline(online);
      if (online) void refresh();
    });
    const session = useSessionStore.subscribe((next, previous) => {
      if (next.session?.pubkey === previous.session?.pubkey) return;
      version.current++;
      if (previous.session) pending.current = null;
      void openPending();
      void refresh();
    });
    const received =
      Platform.OS !== "web"
        ? Notifications.addNotificationReceivedListener((notification) => {
            receiveDeviceChallenge(notification.request.content.data);
            if (parseSellerActivityPayload(notification.request.content.data)) {
              useNotificationState.setState({
                message: "New seller activity. Open Orders to review.",
              });
              void refresh();
            }
          })
        : null;
    const tapped =
      Platform.OS !== "web"
        ? Notifications.addNotificationResponseReceivedListener(response)
        : null;
    const token =
      Platform.OS !== "web"
        ? Notifications.addPushTokenListener(handleNativeTokenChange)
        : null;
    if (Platform.OS !== "web")
      void Notifications.getLastNotificationResponseAsync()
        .then((value) => {
          if (active && value && !pending.current) response(value);
        })
        .catch(() => {});
    void Network.getNetworkStateAsync()
      .then((state) => {
        if (active)
          onlineManager.setOnline(
            state.isConnected !== false && state.isInternetReachable !== false
          );
      })
      .catch(() => {});
    focusManager.setFocused(AppState.currentState === "active");
    void refresh();
    return () => {
      active = false;
      version.current++;
      app.remove();
      net.remove();
      session();
      received?.remove();
      tapped?.remove();
      token?.remove();
    };
  }, [navigation?.key, router]);
  return null;
}
