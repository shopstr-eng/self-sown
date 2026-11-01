import { useMemo, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  computePosCartTotals,
  pricePosCartLine,
  validatePosBuyerEmail,
  validatePosNote,
} from "@self-sown/domain";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
  SellerField,
} from "@/components/seller-ui";
import { loadNwcConnection } from "@/lib/nwc";
import { loadAccountPreferences } from "@/lib/account-settings";
import { fetchPosPaymentMethods } from "@/lib/pos-api";
import { usePosCartStore } from "@/lib/pos-cart-store";
import { formatPosAmount } from "@/lib/pos-fx";
import { buildPosReceiptLines } from "@/lib/pos-receipt";
import { finalizePosSale } from "@/lib/pos-sale";
import { isStripeTerminalAvailable } from "@/lib/pos-stripe-terminal";
import { getErrorMessage } from "@/lib/error-utils";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

export default function PosCartScreen() {
  const router = useRouter();
  const session = useSessionStore((state) => state.session);
  const lines = usePosCartStore((state) => state.lines);
  const note = usePosCartStore((state) => state.note);
  const buyerEmail = usePosCartStore((state) => state.buyerEmail);
  const setQuantity = usePosCartStore((state) => state.setQuantity);
  const removeLine = usePosCartStore((state) => state.removeLine);
  const setNote = usePosCartStore((state) => state.setNote);
  const setBuyerEmail = usePosCartStore((state) => state.setBuyerEmail);
  const beginSale = usePosCartStore((state) => state.beginSale);
  const completeSale = usePosCartStore((state) => state.completeSale);

  const [fieldError, setFieldError] = useState("");
  const [busy, setBusy] = useState(false);

  const methodsQuery = useQuery({
    queryKey: ["pos-payment-methods", session?.pubkey],
    enabled: Boolean(session),
    staleTime: 60_000,
    queryFn: async () => {
      if (!session) throw new Error("No session");
      const [methods, nwc, preferences] = await Promise.all([
        fetchPosPaymentMethods(session).catch(() => null),
        loadNwcConnection(session.pubkey).catch(() => null),
        loadAccountPreferences(session).catch(() => null),
      ]);
      return {
        // NWC preferred; the seller's active Cashu mint issues the invoice
        // when no wallet is connected (funds land as ecash in Settings).
        lightning: Boolean(nwc) || Boolean(preferences?.mints[0]),
        stripeTerminal:
          Boolean(methods?.stripe.chargesEnabled) &&
          isStripeTerminalAvailable(),
        square: Boolean(methods?.square.connected),
      };
    },
  });

  const totals = useMemo(() => {
    try {
      return computePosCartTotals(lines);
    } catch {
      return null;
    }
  }, [lines]);

  if (!session) return null;

  const validate = (): boolean => {
    const noteError = validatePosNote(note);
    if (noteError) {
      setFieldError(noteError);
      return false;
    }
    const emailError = validatePosBuyerEmail(buyerEmail);
    if (emailError) {
      setFieldError(emailError);
      return false;
    }
    setFieldError("");
    return true;
  };

  const startCharge = (href: string) => {
    if (!validate() || !totals || totals.itemCount === 0) return;
    beginSale(Crypto.randomUUID());
    router.push(href as Href);
  };

  const finishCashSale = async () => {
    if (!validate() || !totals || totals.itemCount === 0) return;
    setBusy(true);
    try {
      const sale = await finalizePosSale({
        session,
        lines,
        method: "cash",
        paymentReference: "cash",
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(buyerEmail.trim() ? { buyerEmail: buyerEmail.trim() } : {}),
      });
      completeSale({
        saleId: sale.saleId,
        method: "cash",
        reference: "cash",
        total: totals.total,
        currency: totals.currency,
        itemCount: totals.itemCount,
        receiptLines: buildPosReceiptLines(lines),
        ...(buyerEmail.trim() ? { buyerEmail: buyerEmail.trim() } : {}),
      });
      router.replace("/(tabs)/pos/success" as Href);
    } catch (error) {
      setFieldError(getErrorMessage(error, "Could not record the sale."));
    } finally {
      setBusy(false);
    }
  };

  const methods = methodsQuery.data;

  return (
    <ScreenScrollView adjustForKeyboard>
      <ScreenTitle title="Review sale" />

      {lines.length === 0 ? (
        <SellerCard title="Cart is empty">
          <ActionButton
            label="Back to products"
            variant="secondary"
            onPress={() => router.back()}
          />
        </SellerCard>
      ) : (
        <SellerCard title="Items">
          {lines.map((line) => {
            const pricing = pricePosCartLine(line.item, line.quantity);
            return (
              <View key={line.key} style={styles.lineRow}>
                <View style={styles.lineInfo}>
                  <Text style={styles.lineTitle} numberOfLines={1}>
                    {line.item.title}
                  </Text>
                  <Text style={styles.linePrice}>
                    {formatPosAmount(pricing.total, line.item.currency)}
                    {pricing.savings > 0
                      ? `  (saved ${formatPosAmount(pricing.savings, line.item.currency)})`
                      : ""}
                  </Text>
                </View>
                <View style={styles.stepper}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Decrease ${line.item.title} quantity`}
                    style={styles.stepButton}
                    onPress={() => setQuantity(line.key, line.quantity - 1)}
                  >
                    <Text style={styles.stepButtonText}>−</Text>
                  </Pressable>
                  <Text style={styles.qtyText}>{line.quantity}</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Increase ${line.item.title} quantity`}
                    style={styles.stepButton}
                    onPress={() => setQuantity(line.key, line.quantity + 1)}
                  >
                    <Text style={styles.stepButtonText}>+</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${line.item.title}`}
                    onPress={() => removeLine(line.key)}
                  >
                    <Text style={styles.removeText}>Remove</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </SellerCard>
      )}

      {totals && totals.itemCount > 0 ? (
        <>
          <SellerCard title="Total">
            {totals.savings > 0 ? (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Quantity discounts</Text>
                <Text style={styles.savingsValue}>
                  −{formatPosAmount(totals.savings, totals.currency)}
                </Text>
              </View>
            ) : null}
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.totalValue}>
                {formatPosAmount(totals.total, totals.currency)}
              </Text>
            </View>
          </SellerCard>

          <SellerCard title="Sale details (optional)">
            <SellerField
              label="Note"
              value={note}
              onChangeText={setNote}
              placeholder="e.g. farmers market stand"
              maxLength={512}
            />
            <SellerField
              label="Buyer email for receipt"
              value={buyerEmail}
              onChangeText={setBuyerEmail}
              placeholder="buyer@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              maxLength={254}
            />
          </SellerCard>

          {fieldError ? <Text style={styles.errorText}>{fieldError}</Text> : null}

          <SellerCard title="Payment method">
            {/* Apple checklist 5.2: with multiple payment options, Tap to Pay
                leads the list; the button stays enabled even before Tap to
                Pay is turned on — pressing it flows into Apple's Terms &
                Conditions acceptance via the SDK (5.3). */}
            {methods?.stripeTerminal ? (
              <View style={styles.methodGap}>
                <ActionButton
                  label="Tap to Pay on iPhone"
                  onPress={() => startCharge("/(tabs)/pos/card")}
                />
              </View>
            ) : null}
            {methods?.lightning ? (
              <View style={styles.methodGap}>
                <ActionButton
                  label="Lightning (Bitcoin)"
                  onPress={() =>
                    startCharge("/(tabs)/pos/lightning")
                  }
                />
              </View>
            ) : null}
            {methods?.square ? (
              <View style={styles.methodGap}>
                <ActionButton
                  label="Card via Square link"
                  onPress={() => startCharge("/(tabs)/pos/square")}
                />
              </View>
            ) : null}
            <View style={styles.methodGap}>
              <ActionButton
                label="Cash / other"
                variant="secondary"
                loading={busy}
                onPress={() => void finishCashSale()}
              />
            </View>
            {!methodsQuery.isLoading &&
            !methods?.lightning &&
            !methods?.stripeTerminal &&
            !methods?.square ? (
              <Text style={styles.hintText}>
                Connect a Lightning wallet or Cashu mint (Settings), or
                Stripe/Square (web dashboard), to take digital payments in
                person.
              </Text>
            ) : null}
          </SellerCard>
        </>
      ) : null}
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  lineRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: sellerThemeTokens.subduedSurface,
    gap: 8,
  },
  lineInfo: { gap: 2 },
  lineTitle: {
    fontFamily: sellerFonts.bold,
    color: sellerThemeTokens.text,
    fontSize: 15,
  },
  linePrice: {
    fontFamily: sellerFonts.semibold,
    color: sellerThemeTokens.primary,
    fontSize: 13,
  },
  stepper: { flexDirection: "row", alignItems: "center", gap: 12 },
  stepButton: {
    width: 36,
    height: 36,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: sellerThemeTokens.surface,
  },
  stepButtonText: {
    fontFamily: sellerFonts.extrabold,
    fontSize: 18,
    color: sellerThemeTokens.text,
  },
  qtyText: {
    fontFamily: sellerFonts.bold,
    fontSize: 16,
    minWidth: 28,
    textAlign: "center",
    color: sellerThemeTokens.text,
  },
  removeText: {
    fontFamily: sellerFonts.semibold,
    color: sellerThemeTokens.danger,
    fontSize: 13,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  totalLabel: {
    fontFamily: sellerFonts.semibold,
    color: sellerThemeTokens.mutedText,
    fontSize: 14,
  },
  totalValue: {
    fontFamily: sellerFonts.extrabold,
    color: sellerThemeTokens.text,
    fontSize: 22,
  },
  savingsValue: {
    fontFamily: sellerFonts.bold,
    color: sellerThemeTokens.success,
    fontSize: 15,
  },
  methodGap: { marginBottom: 10 },
  hintText: {
    fontFamily: sellerFonts.regular,
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    marginTop: 4,
  },
  errorText: {
    fontFamily: sellerFonts.semibold,
    color: sellerThemeTokens.danger,
    fontSize: 14,
    marginBottom: 12,
  },
});
