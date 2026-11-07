import { useEffect, useMemo, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { Image, Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { computePosCartTotals, type PosCatalogItem } from "@self-sown/domain";

import {
  ActionButton,
  EmptyState,
  ScreenScrollView,
  ScreenTitle,
  SellerField,
} from "@/components/seller-ui";
import LoadingScreen from "@/components/loading-screen";
import { TapToPayAwarenessMoment } from "@/components/tap-to-pay-awareness";
import { useSellerListingEvents } from "@/hooks/use-seller-bootstrap";
import { buildPosCatalog } from "@/lib/pos-catalog";
import { usePosCartStore } from "@/lib/pos-cart-store";
import { formatPosAmount, isSatsCurrency } from "@/lib/pos-fx";
import { flushPendingPosRecords } from "@/lib/pos-sale";
import { sweepPendingCashuQuotes } from "@/lib/pos-cashu";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

export default function PosCatalogScreen() {
  const router = useRouter();
  const session = useSessionStore((state) => state.session);
  const listingEventsQuery = useSellerListingEvents(session?.pubkey);
  const lines = usePosCartStore((state) => state.lines);
  const addItem = usePosCartStore((state) => state.addItem);
  const [customAmountOpen, setCustomAmountOpen] = useState(false);
  const [customAmount, setCustomAmount] = useState("");
  const [customError, setCustomError] = useState("");

  // Retry publishing any sale records a previous session couldn't deliver,
  // and claim any Cashu quotes that got paid while the app was away.
  useEffect(() => {
    if (!session) return;
    void flushPendingPosRecords(session).catch(() => {});
    void sweepPendingCashuQuotes(session.pubkey).catch(() => {});
  }, [session]);

  const catalog = useMemo(() => {
    if (!session || !listingEventsQuery.data) return [];
    return buildPosCatalog(listingEventsQuery.data, session.pubkey);
  }, [listingEventsQuery.data, session]);

  const cartCurrency = lines[0]?.item.currency ?? "";
  const totals = useMemo(() => {
    try {
      return computePosCartTotals(lines);
    } catch {
      return null;
    }
  }, [lines]);

  if (!session) return null;
  if (listingEventsQuery.isLoading && !listingEventsQuery.data) {
    return <LoadingScreen message="Loading your products..." />;
  }

  const addCustomAmount = () => {
    const amount = Number(customAmount.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      setCustomError("Enter an amount greater than zero.");
      return;
    }
    const currency = cartCurrency || "USD";
    const item: PosCatalogItem = {
      address: `30402:${session.pubkey}:pos-custom`,
      dTag: "pos-custom",
      title: "Custom amount",
      price: isSatsCurrency(currency) ? Math.round(amount) : amount,
      currency,
    };
    addItem(item);
    setCustomAmountOpen(false);
    setCustomAmount("");
    setCustomError("");
  };

  return (
    <View style={styles.screen}>
      {/* Apple checklist 3.1-3.3: one-time full-screen awareness moment for
          every eligible seller. */}
      <TapToPayAwarenessMoment session={session} />
      <ScreenScrollView>
        <ScreenTitle
          eyebrow="In-person sales"
          title="Point of Sale"
          description="Tap products to add them to the sale."
        />
        {catalog.length === 0 ? (
          <EmptyState
            title="No active listings"
            description="Create a listing first, or use a custom amount below."
          />
        ) : (
          <View style={styles.grid}>
            {catalog.map((item) => {
              const disabled =
                Boolean(cartCurrency) && item.currency !== cartCurrency;
              const inCart = lines.find(
                (line) => line.item.address === item.address
              );
              return (
                <Pressable
                  key={item.address}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${item.title}`}
                  accessibilityState={{ disabled }}
                  disabled={disabled}
                  onPress={() => addItem(item)}
                  style={({ pressed }) => [
                    styles.tile,
                    disabled && styles.tileDisabled,
                    pressed && !disabled && styles.tilePressed,
                  ]}
                >
                  {item.image ? (
                    <Image
                      source={{ uri: item.image }}
                      style={styles.tileImage}
                    />
                  ) : null}
                  <Text style={styles.tileTitle} numberOfLines={2}>
                    {item.title}
                  </Text>
                  <Text style={styles.tilePrice}>
                    {formatPosAmount(item.price, item.currency)}
                  </Text>
                  {item.bulkPrices && item.bulkPrices.size > 0 ? (
                    <Text style={styles.tileBulk}>Quantity discounts</Text>
                  ) : null}
                  {inCart ? (
                    <View style={styles.qtyBadge}>
                      <Text style={styles.qtyBadgeText}>{inCart.quantity}</Text>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        )}

        <Pressable
          accessibilityRole="button"
          onPress={() => setCustomAmountOpen(true)}
          style={({ pressed }) => [
            styles.customTile,
            pressed && styles.tilePressed,
          ]}
        >
          <Text style={styles.customTileText}>+ Custom amount</Text>
        </Pressable>
        <View style={{ height: 120 }} />
      </ScreenScrollView>

      {totals && totals.itemCount > 0 ? (
        <View style={styles.cartBar}>
          <View>
            <Text style={styles.cartBarCount}>
              {totals.itemCount} item{totals.itemCount === 1 ? "" : "s"}
            </Text>
            <Text style={styles.cartBarTotal}>
              {formatPosAmount(totals.total, totals.currency)}
            </Text>
          </View>
          <ActionButton
            label="Review sale"
            onPress={() => router.push("/(tabs)/pos/cart" as Href)}
          />
        </View>
      ) : null}

      <Modal visible={customAmountOpen} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Custom amount</Text>
            <SellerField
              label={`Amount (${cartCurrency || "USD"})`}
              value={customAmount}
              onChangeText={setCustomAmount}
              placeholder="0.00"
              keyboardType="decimal-pad"
              error={customError}
            />
            <View style={styles.modalButtons}>
              <ActionButton
                label="Cancel"
                variant="secondary"
                onPress={() => {
                  setCustomAmountOpen(false);
                  setCustomAmount("");
                  setCustomError("");
                }}
              />
              <ActionButton label="Add" onPress={addCustomAmount} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: sellerThemeTokens.background },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  tile: {
    width: "47%",
    backgroundColor: sellerThemeTokens.surface,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  tileDisabled: { opacity: 0.4 },
  tilePressed: { transform: [{ translateX: 2 }, { translateY: 2 }] },
  tileImage: { width: "100%", height: 72, borderRadius: 4 },
  tileTitle: {
    fontFamily: sellerFonts.bold,
    color: sellerThemeTokens.text,
    fontSize: 14,
  },
  tilePrice: {
    fontFamily: sellerFonts.semibold,
    color: sellerThemeTokens.primary,
    fontSize: 13,
  },
  tileBulk: {
    fontFamily: sellerFonts.regular,
    color: sellerThemeTokens.success,
    fontSize: 11,
  },
  qtyBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    backgroundColor: sellerThemeTokens.primary,
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  qtyBadgeText: {
    color: sellerThemeTokens.surface,
    fontFamily: sellerFonts.bold,
    fontSize: 12,
  },
  customTile: {
    marginTop: 12,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: sellerThemeTokens.black,
    borderRadius: 8,
    padding: 16,
    alignItems: "center",
    backgroundColor: sellerThemeTokens.subduedSurface,
  },
  customTileText: {
    fontFamily: sellerFonts.bold,
    color: sellerThemeTokens.text,
    fontSize: 15,
  },
  cartBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    backgroundColor: sellerThemeTokens.surface,
    borderTopWidth: 2,
    borderTopColor: sellerThemeTokens.black,
  },
  cartBarCount: {
    fontFamily: sellerFonts.semibold,
    color: sellerThemeTokens.mutedText,
    fontSize: 12,
  },
  cartBarTotal: {
    fontFamily: sellerFonts.extrabold,
    color: sellerThemeTokens.text,
    fontSize: 20,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: sellerThemeTokens.surface,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    borderRadius: 10,
    padding: 20,
    gap: 8,
  },
  modalTitle: {
    fontFamily: sellerFonts.extrabold,
    fontSize: 18,
    color: sellerThemeTokens.text,
  },
  modalButtons: { flexDirection: "row", gap: 12, marginTop: 8 },
});
