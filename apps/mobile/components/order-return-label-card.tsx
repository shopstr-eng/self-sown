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
  type SellerOrder,
  type SellerParcel,
  type SellerSession,
  type SellerShippingAddress,
} from "@self-sown/domain";
import { ActionButton, SellerCard } from "@/components/seller-ui";
import { useReturnLabels } from "@/hooks/use-return-labels";
import { sellerThemeTokens } from "@/theme/tokens";

interface Props {
  session: SellerSession;
  order: SellerOrder;
  from: SellerShippingAddress | null;
  parcel: SellerParcel | null;
}
export function OrderReturnLabelCard(props: Props) {
  const returns = useReturnLabels(props);
  const { defaults } = returns;
  const openDocument = async (url: string) => {
    if (!isSafeShippingUrl(url)) return;
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert(
        "Could not open link",
        "Please try again from label history."
      );
    }
  };
  return (
    <SellerCard
      title="Return shipping"
      description="Buy a label for the buyer to send this order back to your saved shipping address. Requires an active Herd membership."
    >
      {returns.labels.map((label) => (
        <View key={label.shipmentId} style={styles.group}>
          <Text style={styles.title}>
            Return label · {label.carrier} {label.service}
          </Text>
          <Text selectable style={styles.text}>
            {label.currency} {(label.rateUsd ?? label.rate ?? 0).toFixed(2)} ·{" "}
            {label.trackingCode || "Tracking pending"}
          </Text>
          <ActionButton
            label="Open return label PDF"
            variant="secondary"
            disabled={!isSafeShippingUrl(label.labelUrl)}
            onPress={() => void openDocument(label.labelUrl)}
          />
          {label.trackingUrl && isSafeShippingUrl(label.trackingUrl) ? (
            <ActionButton
              label="Track return shipment"
              variant="secondary"
              onPress={() => void openDocument(label.trackingUrl!)}
            />
          ) : null}
        </View>
      ))}
      {returns.labels.length === 0 ? (
        <>
          {props.from ? (
            <View style={styles.group}>
              <Text style={styles.title}>Return from · Buyer</Text>
              <Text selectable style={styles.text}>
                {[
                  props.from.name,
                  props.from.street1,
                  props.from.street2,
                  props.from.city,
                  props.from.state,
                  props.from.postalCode,
                  props.from.country,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </Text>
            </View>
          ) : null}
          {defaults ? (
            <View style={styles.group}>
              <Text style={styles.title}>Return to · Your saved address</Text>
              <Text selectable style={styles.text}>
                {[
                  defaults.fromName,
                  defaults.fromStreet1,
                  defaults.fromStreet2,
                  defaults.fromCity,
                  defaults.fromState,
                  defaults.fromZip,
                  defaults.fromCountry,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </Text>
            </View>
          ) : null}
          {props.parcel ? (
            <Text style={styles.text}>
              Package: {props.parcel.weightOz} oz
              {props.parcel.lengthIn &&
              props.parcel.widthIn &&
              props.parcel.heightIn
                ? ` · ${props.parcel.lengthIn} × ${props.parcel.widthIn} × ${props.parcel.heightIn} in`
                : ""}
            </Text>
          ) : null}
          <Text style={styles.title}>Preferred carriers</Text>
          <View style={styles.carriers}>
            {["USPS", "UPS", "FedEx"].map((carrier) => {
              const selected = returns.carriers.includes(carrier);
              return (
                <Pressable
                  key={carrier}
                  accessibilityRole="checkbox"
                  accessibilityState={{
                    checked: selected,
                    disabled: returns.buying,
                  }}
                  accessibilityLabel={carrier}
                  disabled={returns.buying}
                  style={[styles.carrier, selected && styles.selected]}
                  onPress={() =>
                    returns.setCarriers((current) =>
                      selected
                        ? current.length > 1
                          ? current.filter((item) => item !== carrier)
                          : current
                        : [...current, carrier]
                    )
                  }
                >
                  <Text style={[styles.text, selected && styles.selectedText]}>
                    {carrier}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.helper}>
            Shippo buys the cheapest available rate, preferring your selected
            carriers. The final price appears after purchase.
          </Text>
          {returns.issue ? (
            <Text style={styles.error}>{returns.issue}</Text>
          ) : null}
          <ActionButton
            label="Buy return label"
            loading={returns.buying}
            disabled={!returns.ready}
            onPress={() => {
              Alert.alert(
                "Buy return label?",
                "Shippo will charge your connected seller account for the selected return service. This buys a shipping label; it does not refund or change the order status.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Buy return label",
                    onPress: () => void returns.purchase(),
                  },
                ]
              );
            }}
          />
        </>
      ) : null}
      {returns.error ? <Text style={styles.error}>{returns.error}</Text> : null}
      <ActionButton
        label="Refresh return shipping"
        variant="secondary"
        loading={returns.loading}
        disabled={returns.buying}
        onPress={() => void returns.refresh()}
      />
    </SellerCard>
  );
}
const styles = StyleSheet.create({
  group: { gap: 8 },
  title: { color: sellerThemeTokens.text, fontSize: 15, fontWeight: "700" },
  text: { color: sellerThemeTokens.text, fontSize: 14, lineHeight: 21 },
  helper: { color: sellerThemeTokens.mutedText, fontSize: 13, lineHeight: 19 },
  error: { color: sellerThemeTokens.danger, fontSize: 14, lineHeight: 20 },
  carriers: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  carrier: {
    padding: 12,
    borderWidth: 1,
    borderColor: sellerThemeTokens.border,
    borderRadius: 12,
  },
  selected: {
    backgroundColor: sellerThemeTokens.primary,
    borderColor: sellerThemeTokens.primary,
  },
  selectedText: { color: sellerThemeTokens.surface },
});
