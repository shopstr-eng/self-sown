import {
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  isSafeShippingUrl,
  type NostrEventRecord,
  type SellerOrder,
  type SellerSession,
} from "@milk-market/domain";

import { ActionButton, SellerCard } from "@/components/seller-ui";
import { useOrderShipping } from "@/hooks/use-order-shipping";
import { sellerThemeTokens } from "@/theme/tokens";

interface OrderShippingCardProps {
  session: SellerSession;
  order: SellerOrder;
  listingEvents?: NostrEventRecord[];
  onTrackingDetails(details: {
    carrier: string;
    tracking: string;
    purchased: boolean;
  }): void;
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

export function OrderShippingCard(props: OrderShippingCardProps) {
  const shipping = useOrderShipping(props);
  if (
    props.order.pickupLocation ||
    (props.order.status !== "confirmed" && shipping.labels.length === 0)
  ) {
    return null;
  }

  return (
    <SellerCard
      title="Shipping label"
      description="Buying a label does not change order status. Mark it shipped only after reviewing tracking."
    >
      {shipping.labels.map((label) => (
        <View
          key={`${label.shipmentId}:${label.id ?? "label"}`}
          style={styles.labelResult}
        >
          <DetailRow
            label="Service"
            value={`${label.carrier || "Carrier pending"}${
              label.service ? ` ${label.service}` : ""
            }`}
          />
          <DetailRow label="Tracking" value={label.trackingCode || "Pending"} />
          <ActionButton
            label="Open label PDF"
            variant="secondary"
            disabled={!isSafeShippingUrl(label.labelUrl)}
            onPress={() => {
              if (isSafeShippingUrl(label.labelUrl)) {
                void Linking.openURL(label.labelUrl);
              }
            }}
          />
        </View>
      ))}

      {shipping.labels.length === 0 && !shipping.shippingAddress ? (
        <Text style={styles.errorText}>
          This order does not contain a complete US shipping address.
        </Text>
      ) : null}
      {shipping.labels.length === 0 && !shipping.parcel ? (
        <Text style={styles.errorText}>
          Add package weight to the matching listing before quoting rates.
        </Text>
      ) : null}

      {shipping.rates.map((rate) => {
        const selected = rate.id === shipping.selectedRateId;
        return (
          <Pressable
            key={rate.id}
            onPress={() => shipping.setSelectedRateId(rate.id)}
            style={[styles.rateRow, selected ? styles.rateSelected : null]}
          >
            <Text style={styles.rateTitle}>
              {rate.carrier} {rate.service}
            </Text>
            <Text style={styles.detailValue}>
              {rate.currency} {rate.rate.toFixed(2)}
              {rate.deliveryDays ? ` · ${rate.deliveryDays} days` : ""}
            </Text>
          </Pressable>
        );
      })}

      {shipping.error ? (
        <Text style={styles.errorText}>{shipping.error}</Text>
      ) : null}
      {shipping.labels.length === 0 && shipping.rates.length === 0 ? (
        <ActionButton
          label="Get carrier rates"
          loading={shipping.loading}
          disabled={!shipping.shippingAddress || !shipping.parcel}
          onPress={() => {
            void shipping.quoteRates();
          }}
        />
      ) : null}
      {shipping.labels.length === 0 && shipping.rates.length > 0 ? (
        <ActionButton
          label="Buy selected label"
          loading={shipping.loading}
          disabled={!shipping.selectedRateId}
          onPress={() => {
            Alert.alert(
              "Buy shipping label?",
              "Shippo will charge your connected seller account. This purchase cannot be undone in Milk Market.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Buy label",
                  onPress: () => {
                    void shipping.purchaseLabel();
                  },
                },
              ]
            );
          }}
        />
      ) : null}
    </SellerCard>
  );
}

const styles = StyleSheet.create({
  detailRow: { gap: 4 },
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
  labelResult: { gap: 12 },
  rateRow: {
    gap: 4,
    padding: 14,
    borderWidth: 1,
    borderColor: sellerThemeTokens.border,
    borderRadius: 12,
  },
  rateSelected: {
    borderColor: sellerThemeTokens.primary,
    borderWidth: 2,
  },
  rateTitle: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontWeight: "700",
  },
  errorText: {
    color: sellerThemeTokens.danger,
    fontSize: 14,
    lineHeight: 20,
  },
});
