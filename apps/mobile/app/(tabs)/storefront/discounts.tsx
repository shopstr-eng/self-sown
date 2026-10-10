import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
  SellerField,
  StatusPill,
  EmptyState,
} from "@/components/seller-ui";
import {
  createDiscountCode,
  deleteDiscountCode,
  describeShippingDiscount,
  listDiscountCodes,
  type SellerDiscountCode,
  type ShippingDiscountType,
} from "@/lib/discount-codes";
import { getErrorMessage } from "@/lib/error-utils";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

const SHIPPING_OPTIONS: Array<{
  value: ShippingDiscountType;
  label: string;
}> = [
  { value: "none", label: "No shipping discount" },
  { value: "free", label: "Free shipping" },
  { value: "percent", label: "% off shipping" },
  { value: "fixed", label: "Flat amount off" },
];

function isExpired(expiration: number | null): boolean {
  if (!expiration) return false;
  return Date.now() / 1000 > expiration;
}

// Mirrors the web client rules in components/stall/discount-codes.tsx so the
// seller gets the same immediate feedback before any round-trip.
function validateDraft({
  code,
  discount,
  shippingType,
  shippingValue,
  expiration,
}: {
  code: string;
  discount: string;
  shippingType: ShippingDiscountType;
  shippingValue: string;
  expiration: string;
}): string | null {
  if (!code.trim()) return "Enter a code.";
  const discountValue = parseFloat(discount) || 0;
  const shipValue =
    shippingType === "free" ? 0 : parseFloat(shippingValue) || 0;

  if (discountValue <= 0 && shippingType === "none") {
    return "Set a product discount or a shipping discount.";
  }
  if (discountValue < 0 || discountValue > 100) {
    return "Product discount must be between 0 and 100.";
  }
  if (shippingType === "percent" && (shipValue <= 0 || shipValue > 100)) {
    return "Shipping % off must be between 0 and 100.";
  }
  if (shippingType === "fixed" && shipValue <= 0) {
    return "Flat shipping discount must be greater than 0.";
  }
  if (expiration) {
    const parsed = new Date(`${expiration}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) {
      return "Expiration must be a date like 2026-12-31.";
    }
    if (parsed.getTime() <= Date.now()) {
      return "Expiration must be in the future.";
    }
  }
  return null;
}

export default function DiscountCodesScreen() {
  const session = useSessionStore((state) => state.session);

  const [codes, setCodes] = useState<SellerDiscountCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [formMessage, setFormMessage] = useState("");

  const [code, setCode] = useState("");
  const [discount, setDiscount] = useState("");
  const [expiration, setExpiration] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [shippingType, setShippingType] =
    useState<ShippingDiscountType>("none");
  const [shippingValue, setShippingValue] = useState("");

  const refresh = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setLoadError("");
    try {
      setCodes(await listDiscountCodes(session));
    } catch (caughtError) {
      setLoadError(
        getErrorMessage(caughtError, "Discount codes could not be loaded.")
      );
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!session) return null;

  const handleAdd = async () => {
    const validationError = validateDraft({
      code,
      discount,
      shippingType,
      shippingValue,
      expiration,
    });
    if (validationError) {
      setFormError(validationError);
      setFormMessage("");
      return;
    }

    const normalizedCode = code.trim().toUpperCase();
    const shippingTypeValue =
      shippingType === "free" ? 0 : parseFloat(shippingValue) || 0;

    setSaving(true);
    setFormError("");
    setFormMessage("");
    try {
      await createDiscountCode(session, {
        code: normalizedCode,
        discountPercentage: parseFloat(discount) || 0,
        expiration: expiration
          ? Math.floor(new Date(`${expiration}T00:00:00`).getTime() / 1000)
          : undefined,
        maxUses: maxUses ? parseInt(maxUses, 10) : undefined,
        shippingDiscountType: shippingType,
        shippingDiscountValue: shippingTypeValue,
      });
      setCode("");
      setDiscount("");
      setExpiration("");
      setMaxUses("");
      setShippingType("none");
      setShippingValue("");
      setFormMessage(`Discount code ${normalizedCode} added.`);
      await refresh();
    } catch (caughtError) {
      setFormError(
        getErrorMessage(caughtError, "The discount code could not be added.")
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (codeToDelete: string) => {
    Alert.alert(
      "Delete discount code",
      `Delete ${codeToDelete}? Customers will no longer be able to use it.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await deleteDiscountCode(session, codeToDelete);
                await refresh();
              } catch (caughtError) {
                Alert.alert(
                  "Delete failed",
                  getErrorMessage(
                    caughtError,
                    "The discount code could not be deleted."
                  )
                );
              }
            })();
          },
        },
      ]
    );
  };

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Stall"
        title="Discount codes"
        description="Create codes buyers can use at checkout. A code can take a percentage off products, discount shipping, or both."
      />

      <SellerCard title="Add new code">
        <SellerField
          label="Code"
          value={code}
          onChangeText={(value) => setCode(value.toUpperCase())}
          placeholder="SUMMER2024"
          autoCapitalize="characters"
        />
        <SellerField
          label="Product discount percentage"
          value={discount}
          onChangeText={setDiscount}
          placeholder="10"
          keyboardType="decimal-pad"
        />
        <Text style={styles.helperText}>
          Set to 0 if this code only discounts shipping.
        </Text>

        <View style={styles.shippingGroup}>
          <Text style={styles.shippingLabel}>Shipping discount</Text>
          <View style={styles.shippingOptions}>
            {SHIPPING_OPTIONS.map((option) => {
              const selected = shippingType === option.value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => {
                    setShippingType(option.value);
                    if (option.value === "free" || option.value === "none") {
                      setShippingValue("");
                    }
                  }}
                  style={[
                    styles.shippingOption,
                    selected && styles.shippingOptionSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.shippingOptionLabel,
                      selected && styles.shippingOptionLabelSelected,
                    ]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {shippingType === "percent" || shippingType === "fixed" ? (
            <SellerField
              label={
                shippingType === "percent"
                  ? "Shipping % off"
                  : "Flat amount off (buyer's cart currency)"
              }
              value={shippingValue}
              onChangeText={setShippingValue}
              placeholder={shippingType === "percent" ? "50" : "5"}
              keyboardType="decimal-pad"
            />
          ) : null}
        </View>

        <SellerField
          label="Expiration (optional)"
          value={expiration}
          onChangeText={setExpiration}
          placeholder="2026-12-31"
          autoCapitalize="none"
        />
        <SellerField
          label="Usage limit (optional)"
          value={maxUses}
          onChangeText={setMaxUses}
          placeholder="Leave empty for unlimited"
          keyboardType="number-pad"
        />

        {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
        {formMessage ? (
          <Text style={styles.successText}>{formMessage}</Text>
        ) : null}
        <ActionButton
          label="Add code"
          onPress={() => void handleAdd()}
          loading={saving}
          disabled={!code.trim()}
        />
      </SellerCard>

      <SellerCard title="Active codes" description={`${codes.length} total`}>
        {loading ? (
          <Text style={styles.helperText}>Loading codes...</Text>
        ) : loadError ? (
          <>
            <Text style={styles.errorText}>{loadError}</Text>
            <ActionButton
              label="Retry"
              onPress={() => void refresh()}
              variant="secondary"
            />
          </>
        ) : codes.length === 0 ? (
          <EmptyState
            title="No discount codes yet"
            description="Create your first code above and it will appear here."
          />
        ) : (
          codes.map((entry) => {
            const shippingDescription = describeShippingDiscount(
              entry.shipping_discount_type,
              entry.shipping_discount_value
            );
            const expired = isExpired(entry.expiration);
            const fullyUsed =
              entry.max_uses !== null && entry.times_used >= entry.max_uses;
            return (
              <View key={entry.code} style={styles.codeRow}>
                <View style={styles.codeHeader}>
                  <Text style={styles.codeValue}>{entry.code}</Text>
                  {expired ? (
                    <StatusPill tone="warning" label="Expired" />
                  ) : null}
                  {fullyUsed ? (
                    <StatusPill tone="danger" label="Fully used" />
                  ) : null}
                </View>
                {entry.discount_percentage > 0 ? (
                  <Text style={styles.codeDetail}>
                    {entry.discount_percentage}% off products
                  </Text>
                ) : null}
                {shippingDescription ? (
                  <Text style={styles.codeDetail}>{shippingDescription}</Text>
                ) : null}
                <Text style={styles.codeMeta}>
                  Used: {entry.times_used}
                  {entry.max_uses !== null
                    ? ` / ${entry.max_uses}`
                    : " (unlimited)"}
                </Text>
                {entry.expiration ? (
                  <Text style={styles.codeMeta}>
                    {expired ? "Expired on: " : "Expires: "}
                    {new Date(entry.expiration * 1000).toLocaleDateString()}
                  </Text>
                ) : null}
                <ActionButton
                  label={`Delete ${entry.code}`}
                  onPress={() => handleDelete(entry.code)}
                  variant="secondary"
                />
              </View>
            );
          })
        )}
      </SellerCard>
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  helperText: {
    color: sellerThemeTokens.mutedText,
    fontSize: 14,
    fontFamily: sellerFonts.regular,
    lineHeight: 21,
  },
  errorText: {
    color: sellerThemeTokens.danger,
    fontSize: 14,
    fontFamily: sellerFonts.regular,
    lineHeight: 20,
  },
  successText: {
    color: sellerThemeTokens.success,
    fontSize: 14,
    fontFamily: sellerFonts.regular,
    lineHeight: 20,
  },
  shippingGroup: {
    gap: 8,
  },
  shippingLabel: {
    color: sellerThemeTokens.text,
    fontSize: 14,
    fontFamily: sellerFonts.bold,
  },
  shippingOptions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  shippingOption: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    backgroundColor: sellerThemeTokens.surface,
  },
  shippingOptionSelected: {
    backgroundColor: sellerThemeTokens.primary,
  },
  shippingOptionLabel: {
    color: sellerThemeTokens.text,
    fontSize: 13,
    fontFamily: sellerFonts.bold,
  },
  shippingOptionLabelSelected: {
    color: sellerThemeTokens.surface,
  },
  codeRow: {
    gap: 8,
    padding: 14,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    backgroundColor: sellerThemeTokens.surface,
  },
  codeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  codeValue: {
    color: sellerThemeTokens.text,
    fontSize: 17,
    fontFamily: sellerFonts.bold,
    letterSpacing: 1,
  },
  codeDetail: {
    color: sellerThemeTokens.text,
    fontSize: 14,
    fontFamily: sellerFonts.regular,
  },
  codeMeta: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    fontFamily: sellerFonts.regular,
  },
});
