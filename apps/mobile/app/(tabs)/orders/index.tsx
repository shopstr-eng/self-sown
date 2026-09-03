import { useMemo, useState } from "react";
import { useRouter, type Href } from "expo-router";
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import LoadingScreen from "@/components/loading-screen";
import { OrderStatusBadge } from "@/components/order-status-badge";
import {
  ActionButton,
  EmptyState,
  ScreenTitle,
  SellerCard,
} from "@/components/seller-ui";
import { useSellerOrders } from "@/hooks/use-seller-orders";
import { getErrorMessage } from "@/lib/error-utils";
import {
  filterSellerOrders,
  formatSellerOrderAmount,
  getSellerOrderBuyerLabel,
  getSellerOrderStatusLabel,
  type SellerOrderFilter,
} from "@/lib/order-presenter";
import { useSessionStore } from "@/stores/session-store";
import { sellerThemeTokens } from "@/theme/tokens";

const FILTERS: SellerOrderFilter[] = [
  "all",
  "pending",
  "confirmed",
  "shipped",
  "completed",
];

function getFilterLabel(filter: SellerOrderFilter): string {
  return filter === "all" ? "All" : getSellerOrderStatusLabel(filter);
}

export default function OrdersIndexScreen() {
  const router = useRouter();
  const session = useSessionStore((state) => state.session);
  const ordersQuery = useSellerOrders(session);
  const [filter, setFilter] = useState<SellerOrderFilter>("all");
  const orders = useMemo(
    () => filterSellerOrders(ordersQuery.data?.orders ?? [], filter),
    [filter, ordersQuery.data?.orders]
  );

  if (!session) {
    return null;
  }
  if (ordersQuery.isLoading && !ordersQuery.data) {
    return <LoadingScreen message="Decrypting seller orders..." />;
  }
  if (ordersQuery.isError && !ordersQuery.data) {
    return (
      <View style={styles.errorScreen}>
        <ScreenTitle
          eyebrow="Seller fulfillment"
          title="Orders unavailable"
          description="Your encrypted seller orders could not be loaded right now."
        />
        <SellerCard title="Could not load orders">
          <Text style={styles.errorText}>
            {getErrorMessage(
              ordersQuery.error,
              "Seller orders could not be loaded."
            )}
          </Text>
          <ActionButton
            label="Retry orders"
            variant="secondary"
            loading={ordersQuery.isFetching}
            onPress={() => {
              void ordersQuery.refetch();
            }}
          />
        </SellerCard>
      </View>
    );
  }

  return (
    <FlatList
      data={orders}
      keyExtractor={(order) => order.orderId}
      contentContainerStyle={styles.screen}
      refreshControl={
        <RefreshControl
          refreshing={ordersQuery.isRefetching}
          onRefresh={() => {
            void ordersQuery.refetch();
          }}
          tintColor={sellerThemeTokens.primary}
        />
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <ScreenTitle
            eyebrow="Seller fulfillment"
            title="Orders"
            description="Confirm, ship, and complete orders from your mobile seller workspace."
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filters}
          >
            {FILTERS.map((item) => {
              const selected = item === filter;
              return (
                <Pressable
                  key={item}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Filter orders by ${getFilterLabel(item)}`}
                  onPress={() => setFilter(item)}
                  style={({ pressed }) => [
                    styles.filter,
                    selected ? styles.filterSelected : null,
                    pressed ? styles.pressed : null,
                  ]}
                >
                  <Text
                    style={[
                      styles.filterLabel,
                      selected ? styles.filterLabelSelected : null,
                    ]}
                  >
                    {getFilterLabel(item)}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
          {ordersQuery.data?.rejectedMessageCount ? (
            <Text style={styles.noticeText}>
              {ordersQuery.data.rejectedMessageCount} malformed or unrelated
              message
              {ordersQuery.data.rejectedMessageCount === 1
                ? " was"
                : "s were"}{" "}
              ignored safely.
            </Text>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        <EmptyState
          title={
            filter === "all" ? "No seller orders yet" : "No matching orders"
          }
          description={
            filter === "all"
              ? "New validated orders addressed to this seller will appear here."
              : "Choose another status filter or pull down to refresh."
          }
        />
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open order ${item.orderId}`}
          onPress={() =>
            router.push({
              pathname: "/orders/[orderId]",
              params: { orderId: item.orderId },
            } as Href)
          }
          style={({ pressed }) => [
            styles.orderCard,
            pressed ? styles.pressed : null,
          ]}
        >
          <View style={styles.rowBetween}>
            <View style={styles.orderTitleBlock}>
              <View style={styles.titleRow}>
                {item.unread ? (
                  <View
                    accessibilityLabel="Unread order"
                    style={styles.unreadDot}
                  />
                ) : null}
                <Text numberOfLines={2} style={styles.orderTitle}>
                  {item.productTitle ?? "Seller order"}
                </Text>
              </View>
              <Text style={styles.orderId} numberOfLines={1}>
                #{item.orderId.slice(0, 12)}
              </Text>
            </View>
            <OrderStatusBadge status={item.status} />
          </View>
          <View style={styles.rowBetween}>
            <Text style={styles.metaText}>Quantity {item.quantity}</Text>
            <Text style={styles.amountText}>
              {formatSellerOrderAmount(item)}
            </Text>
          </View>
          <View style={styles.rowBetween}>
            <Text numberOfLines={1} style={styles.metaText}>
              Buyer: {getSellerOrderBuyerLabel(item)}
            </Text>
            <Text style={styles.metaText}>
              {new Date(item.updatedAt * 1000).toLocaleDateString()}
            </Text>
          </View>
          <Text numberOfLines={1} style={styles.metaText}>
            {item.paymentMethod
              ? `Payment: ${item.paymentMethod}`
              : "Payment method unavailable"}
          </Text>
        </Pressable>
      )}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
    />
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    padding: 20,
    paddingBottom: 36,
    backgroundColor: sellerThemeTokens.background,
  },
  errorScreen: {
    flex: 1,
    gap: 16,
    padding: 20,
    backgroundColor: sellerThemeTokens.background,
  },
  header: {
    gap: 16,
    marginBottom: 18,
  },
  filters: {
    gap: 8,
  },
  filter: {
    minHeight: 42,
    justifyContent: "center",
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: sellerThemeTokens.border,
    borderRadius: 999,
    backgroundColor: sellerThemeTokens.surface,
  },
  filterSelected: {
    borderColor: sellerThemeTokens.primary,
    backgroundColor: sellerThemeTokens.primary,
  },
  filterLabel: {
    color: sellerThemeTokens.text,
    fontSize: 14,
    fontWeight: "700",
  },
  filterLabelSelected: {
    color: sellerThemeTokens.surface,
  },
  noticeText: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    lineHeight: 19,
  },
  orderCard: {
    gap: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: sellerThemeTokens.border,
    borderRadius: 18,
    backgroundColor: sellerThemeTokens.surface,
  },
  pressed: {
    opacity: 0.82,
  },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  orderTitleBlock: {
    flex: 1,
    gap: 4,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  unreadDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: sellerThemeTokens.accent,
  },
  orderTitle: {
    flex: 1,
    color: sellerThemeTokens.text,
    fontSize: 18,
    fontWeight: "700",
  },
  orderId: {
    color: sellerThemeTokens.mutedText,
    fontSize: 12,
  },
  metaText: {
    flexShrink: 1,
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
  },
  amountText: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontWeight: "700",
  },
  separator: {
    height: 12,
  },
  errorText: {
    color: sellerThemeTokens.danger,
    fontSize: 14,
    lineHeight: 20,
  },
});
