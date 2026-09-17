import { Image, StyleSheet, Text, View } from "react-native";
import type { SellerListingSummary } from "@milk-market/domain";
import { ActionButton, StatusPill } from "./seller-ui";
import { catalogTheme as theme } from "./catalog-appearance";
export function ListingCard({
  listing,
  imageUrl,
  busyAction,
  onEdit,
  onToggleStatus,
  onDelete,
}: {
  listing: SellerListingSummary;
  imageUrl?: string;
  busyAction: "" | "status" | "delete";
  onEdit(): void;
  onToggleStatus(): void;
  onDelete(): void;
}) {
  return (
    <View style={styles.card}>
      {imageUrl ? (
        <Image
          accessibilityLabel={listing.title}
          source={{ uri: imageUrl }}
          style={styles.image}
        />
      ) : (
        <View style={[styles.image, styles.placeholder]}>
          <Text style={styles.meta}>No product photo</Text>
        </View>
      )}
      <View style={styles.body}>
        <View style={styles.heading}>
          <Text style={styles.category}>
            {listing.primaryCategory ?? "Product"}
          </Text>
          <StatusPill
            tone={listing.status === "active" ? "success" : "warning"}
            label={listing.status === "active" ? "Active" : "Inactive"}
          />
        </View>
        <Text style={styles.title}>{listing.title}</Text>
        <Text style={styles.price}>
          {listing.price === null || !listing.currency
            ? "Price unavailable"
            : `${listing.currency} ${listing.price.toLocaleString(undefined, { maximumFractionDigits: 8 })}`}
        </Text>
        <ActionButton
          label="Edit product"
          onPress={onEdit}
          disabled={Boolean(busyAction)}
        />
        <View style={styles.actions}>
          <View style={styles.grow}>
            <ActionButton
              label={
                listing.status === "active" ? "Make inactive" : "Make active"
              }
              variant="secondary"
              onPress={onToggleStatus}
              loading={busyAction === "status"}
              disabled={Boolean(busyAction)}
            />
          </View>
          <View style={styles.grow}>
            <ActionButton
              label="Delete"
              variant="secondary"
              onPress={onDelete}
              loading={busyAction === "delete"}
              disabled={Boolean(busyAction)}
            />
          </View>
        </View>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    borderWidth: 2,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    borderRadius: 8,
    overflow: "hidden",
  },
  image: {
    width: "100%",
    aspectRatio: 1.6,
    backgroundColor: theme.subduedSurface,
  },
  placeholder: { alignItems: "center", justifyContent: "center" },
  body: { padding: 18, gap: 14 },
  heading: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  title: { color: theme.text, fontSize: 24, fontWeight: "700", lineHeight: 30 },
  price: { color: theme.text, fontSize: 21, fontWeight: "700" },
  category: { color: theme.mutedText, fontSize: 13, fontWeight: "600" },
  meta: { color: theme.mutedText },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  grow: { flexGrow: 1, flexBasis: 130 },
});
