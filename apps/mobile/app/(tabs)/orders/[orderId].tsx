import { useEffect, useRef, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  getNextSellerOrderStatus,
  validateSellerShippingUpdate,
  type SellerOrderStatus,
} from "@milk-market/domain";

import LoadingScreen from "@/components/loading-screen";
import { OrderStatusBadge } from "@/components/order-status-badge";
import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
  SellerField,
} from "@/components/seller-ui";
import { useSellerOrder } from "@/hooks/use-seller-orders";
import { getErrorMessage } from "@/lib/error-utils";
import type {
  SellerManagedOrderStatus,
  SellerOrderActionProgress,
} from "@/lib/order-actions";
import {
  formatSellerOrderAmount,
  getSellerOrderActionLabel,
  getSellerOrderStatusLabel,
} from "@/lib/order-presenter";
import {
  sellerOrdersQueryKey,
  type SellerOrdersQueryData,
} from "@/lib/order-query";
import {
  markSellerOrderMessagesRead,
  mobileSellerOrderActionCoordinator,
} from "@/lib/seller-order-runtime";
import { useSessionStore } from "@/stores/session-store";
import { sellerThemeTokens } from "@/theme/tokens";

function isSellerManagedStatus(
  status: SellerOrderStatus | null
): status is SellerManagedOrderStatus {
  return (
    status === "confirmed" || status === "shipped" || status === "completed"
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text selectable style={styles.detailValue}>
        {value}
      </Text>
    </View>
  );
}

export default function SellerOrderDetailScreen() {
  const { orderId } = useLocalSearchParams<{ orderId?: string }>();
  const queryClient = useQueryClient();
  const session = useSessionStore((state) => state.session);
  const { order, ordersQuery } = useSellerOrder(session, orderId);
  const markedReadKey = useRef("");
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [shippingErrors, setShippingErrors] = useState<{
    carrier?: string;
    tracking?: string;
  }>({});
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [retryProgress, setRetryProgress] =
    useState<SellerOrderActionProgress | null>(null);

  useEffect(() => {
    setCarrier("");
    setTracking("");
    setShippingErrors({});
    setActionError("");
    setActionMessage("");
    setRetryProgress(null);
  }, [orderId]);

  useEffect(() => {
    if (!session || !order || !order.unread) {
      return;
    }
    const readKey = `${session.pubkey}:${order.orderId}:${order.wrappedEventIds.join(",")}`;
    if (markedReadKey.current === readKey) {
      return;
    }
    markedReadKey.current = readKey;

    void markSellerOrderMessagesRead(session, order)
      .then(() => {
        queryClient.setQueryData<SellerOrdersQueryData>(
          sellerOrdersQueryKey(session.pubkey),
          (current) =>
            current
              ? {
                  ...current,
                  orders: current.orders.map((candidate) =>
                    candidate.orderId === order.orderId
                      ? { ...candidate, unread: false }
                      : candidate
                  ),
                }
              : current
        );
      })
      .catch(() => {
        markedReadKey.current = "";
      });
  }, [order, queryClient, session]);

  if (!session || !orderId) {
    return null;
  }
  if (ordersQuery.isLoading && !ordersQuery.data) {
    return <LoadingScreen message="Decrypting order details..." />;
  }
  if (ordersQuery.isError && !ordersQuery.data) {
    return (
      <ScreenScrollView>
        <ScreenTitle
          eyebrow="Seller fulfillment"
          title="Order unavailable"
          description="The encrypted order could not be loaded right now."
        />
        <Text style={styles.errorText}>
          {getErrorMessage(
            ordersQuery.error,
            "Order details could not be loaded."
          )}
        </Text>
        <ActionButton
          label="Retry order"
          variant="secondary"
          loading={ordersQuery.isFetching}
          onPress={() => {
            void ordersQuery.refetch();
          }}
        />
      </ScreenScrollView>
    );
  }
  if (!order) {
    return (
      <ScreenScrollView>
        <ScreenTitle
          eyebrow="Seller fulfillment"
          title="Order not found"
          description="This order is not present in the validated seller inbox."
        />
        <ActionButton
          label="Refresh orders"
          variant="secondary"
          loading={ordersQuery.isFetching}
          onPress={() => {
            void ordersQuery.refetch();
          }}
        />
      </ScreenScrollView>
    );
  }

  const nextStatus = getNextSellerOrderStatus(order.status);
  const actionStatus = retryProgress?.nextStatus ?? nextStatus;
  const managedActionStatus = isSellerManagedStatus(actionStatus)
    ? actionStatus
    : null;
  const actionLabel = retryProgress
    ? "Retry status update"
    : getSellerOrderActionLabel(order.status);

  const runStatusAction = async () => {
    if (!managedActionStatus) {
      return;
    }

    let shipping: { carrier?: string; tracking?: string } | undefined;
    if (managedActionStatus === "shipped") {
      const validation = validateSellerShippingUpdate({ carrier, tracking });
      setShippingErrors({
        ...(validation.errors.carrier
          ? { carrier: validation.errors.carrier }
          : {}),
        ...(validation.errors.tracking
          ? { tracking: validation.errors.tracking }
          : {}),
      });
      if (Object.keys(validation.errors).length > 0) {
        return;
      }
      shipping = validation.value;
    }

    setActionLoading(true);
    setActionError("");
    setActionMessage("");
    try {
      const result = await mobileSellerOrderActionCoordinator.execute({
        session,
        order,
        nextStatus: managedActionStatus,
        ...(shipping ? { shipping } : {}),
        ...(retryProgress ? { previousProgress: retryProgress } : {}),
      });

      if (result.ok) {
        setRetryProgress(null);
        setActionMessage(
          result.progress.buyerNotificationRequired
            ? "Status saved and the encrypted buyer update was published."
            : "Status saved. No encrypted buyer notification was available for this order."
        );
      } else {
        setActionError(result.message);
        setRetryProgress(
          result.code === "SERVER_PERSISTENCE_FAILED" ||
            result.code === "BUYER_NOTIFICATION_FAILED"
            ? result.progress
            : null
        );
      }

      if (result.progress.serverPersisted) {
        await ordersQuery.refetch();
      }
    } catch {
      setActionError("The seller order status could not be updated.");
    } finally {
      setActionLoading(false);
    }
  };

  const confirmStatusAction = () => {
    if (!managedActionStatus || !actionLabel) {
      return;
    }
    const statusLabel = getSellerOrderStatusLabel(managedActionStatus);
    Alert.alert(
      `${actionLabel}?`,
      `This will move the order to ${statusLabel.toLowerCase()}.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: actionLabel,
          onPress: () => {
            void runStatusAction();
          },
        },
      ]
    );
  };

  const buyerContact = order.buyerEmail ?? order.contact ?? "Not provided";
  const fulfillment = order.pickupLocation
    ? `Pickup: ${order.pickupLocation}`
    : order.address
      ? order.address
      : "No fulfillment address supplied";

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScreenScrollView>
        <ScreenTitle
          eyebrow="Seller fulfillment"
          title={order.productTitle ?? "Seller order"}
          description={`Order #${order.orderId}`}
        />

        <SellerCard title="Order summary">
          <View style={styles.rowBetween}>
            <Text style={styles.detailLabel}>Status</Text>
            <OrderStatusBadge status={order.status} />
          </View>
          <DetailRow label="Quantity" value={String(order.quantity)} />
          <DetailRow label="Amount" value={formatSellerOrderAmount(order)} />
          <DetailRow
            label="Placed"
            value={new Date(order.createdAt * 1000).toLocaleString()}
          />
        </SellerCard>

        <SellerCard title="Payment">
          <DetailRow
            label="Method"
            value={order.paymentMethod ?? "Not specified"}
          />
          <Text style={styles.privacyNote}>
            Payment proofs and tokens are not displayed in the mobile order
            view.
          </Text>
        </SellerCard>

        <SellerCard
          title="Buyer and fulfillment"
          description={order.isGuest ? "Guest order" : "Signed-in buyer"}
        >
          <DetailRow label="Contact" value={buyerContact} />
          {order.buyerPubkey && !order.isGuest ? (
            <DetailRow
              label="Buyer key"
              value={`${order.buyerPubkey.slice(0, 16)}…`}
            />
          ) : null}
          <DetailRow label="Fulfillment" value={fulfillment} />
          {order.carrier ? (
            <DetailRow label="Carrier" value={order.carrier} />
          ) : null}
          {order.tracking ? (
            <DetailRow label="Tracking" value={order.tracking} />
          ) : null}
        </SellerCard>

        <SellerCard title="Validated order messages">
          {order.history.map((entry) => (
            <View key={entry.sourceEventId} style={styles.historyRow}>
              <View style={styles.historyText}>
                <Text style={styles.historyTitle}>{entry.subject}</Text>
                <Text style={styles.historyMeta}>Message received</Text>
              </View>
              <Text style={styles.historyMeta}>
                {new Date(entry.createdAt * 1000).toLocaleDateString()}
              </Text>
            </View>
          ))}
        </SellerCard>

        <SellerCard
          title="Next seller action"
          description={
            actionLabel
              ? "Only the next valid fulfillment transition is available."
              : "This order has no remaining seller fulfillment action."
          }
        >
          {managedActionStatus === "shipped" ? (
            <View style={styles.fieldGroup}>
              <SellerField
                label="Shipping carrier (optional)"
                value={carrier}
                placeholder="India Post"
                maxLength={80}
                error={shippingErrors.carrier}
                onChangeText={(value) => {
                  setCarrier(value);
                  setShippingErrors((current) => ({
                    ...current,
                    carrier: undefined,
                  }));
                }}
              />
              <SellerField
                label="Tracking number (optional)"
                value={tracking}
                placeholder="Tracking reference"
                autoCapitalize="characters"
                maxLength={120}
                error={shippingErrors.tracking}
                onChangeText={(value) => {
                  setTracking(value);
                  setShippingErrors((current) => ({
                    ...current,
                    tracking: undefined,
                  }));
                }}
              />
            </View>
          ) : null}
          {actionMessage ? (
            <Text style={styles.successText}>{actionMessage}</Text>
          ) : null}
          {actionError ? (
            <Text style={styles.errorText}>{actionError}</Text>
          ) : null}
          {actionLabel ? (
            <ActionButton
              label={actionLabel}
              loading={actionLoading}
              onPress={confirmStatusAction}
            />
          ) : (
            <Text style={styles.privacyNote}>
              Current status: {getSellerOrderStatusLabel(order.status)}.
            </Text>
          )}
        </SellerCard>
      </ScreenScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  detailRow: {
    gap: 4,
  },
  detailLabel: {
    color: sellerThemeTokens.mutedText,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  detailValue: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    lineHeight: 22,
  },
  privacyNote: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    lineHeight: 19,
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 4,
  },
  historyText: {
    flex: 1,
    gap: 3,
  },
  historyTitle: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontWeight: "700",
  },
  historyMeta: {
    color: sellerThemeTokens.mutedText,
    fontSize: 12,
  },
  fieldGroup: {
    gap: 14,
  },
  successText: {
    color: sellerThemeTokens.success,
    fontSize: 14,
    lineHeight: 20,
  },
  errorText: {
    color: sellerThemeTokens.danger,
    fontSize: 14,
    lineHeight: 20,
  },
});
