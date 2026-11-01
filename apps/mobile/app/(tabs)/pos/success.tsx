import { useRouter, type Href } from "expo-router";
import { Share, StyleSheet, Text, View } from "react-native";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
} from "@/components/seller-ui";
import { usePosCartStore } from "@/lib/pos-cart-store";
import { formatPosAmount } from "@/lib/pos-fx";
import { formatPosReceiptText } from "@/lib/pos-receipt";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

const METHOD_LABELS: Record<string, string> = {
  lightning: "Lightning (Bitcoin)",
  card: "Card",
  cash: "Cash / other",
};

export default function PosSuccessScreen() {
  const router = useRouter();
  const sale = usePosCartStore((state) => state.lastCompletedSale);
  const clear = usePosCartStore((state) => state.clear);

  const startNewSale = () => {
    clear();
    router.replace("/(tabs)/pos" as Href);
  };

  // Apple Tap to Pay 5.10: the customer can receive a confidential digital
  // receipt via the system share sheet (SMS, email, or any Activity target).
  const shareReceipt = () => {
    if (!sale) return;
    void Share.share({ message: formatPosReceiptText(sale) }).catch(() => {});
  };

  return (
    <ScreenScrollView>
      <ScreenTitle title="Sale complete" />
      {sale ? (
        <SellerCard title={formatPosAmount(sale.total, sale.currency)}>
          <Text style={styles.detailText}>
            {sale.itemCount} item{sale.itemCount === 1 ? "" : "s"} ·{" "}
            {METHOD_LABELS[sale.method] ?? sale.method}
          </Text>
          {sale.buyerEmail ? (
            <Text style={styles.detailText}>
              Receipt sent to {sale.buyerEmail}
            </Text>
          ) : null}
          <Text style={styles.detailText}>
            Recorded in your Orders as a paid, completed sale.
          </Text>
        </SellerCard>
      ) : (
        <SellerCard title="Sale recorded" />
      )}
      {sale ? (
        <View style={styles.buttonGap}>
          <ActionButton label="Share receipt" onPress={shareReceipt} />
        </View>
      ) : null}
      <View style={styles.buttonGap}>
        <ActionButton
          label="New sale"
          variant={sale ? "secondary" : "primary"}
          onPress={startNewSale}
        />
      </View>
      <ActionButton
        label="View orders"
        variant="secondary"
        onPress={() => router.replace("/(tabs)/orders" as Href)}
      />
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  detailText: {
    fontFamily: sellerFonts.regular,
    color: sellerThemeTokens.mutedText,
    fontSize: 14,
    paddingVertical: 2,
  },
  buttonGap: { marginBottom: 10 },
});
