import { useRouter, type Href } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
} from "@/components/seller-ui";
import { usePosCartStore } from "@/lib/pos-cart-store";
import { formatPosAmount } from "@/lib/pos-fx";
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
      <View style={styles.buttonGap}>
        <ActionButton label="New sale" onPress={startNewSale} />
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
