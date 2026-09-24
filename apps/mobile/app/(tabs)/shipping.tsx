import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { Alert, Pressable, StyleSheet, Switch, Text, View } from "react-native";

import type { SellerShippingDefaults } from "@milk-market/api-client";
import { isSafeShippingUrl } from "@milk-market/domain";

import LoadingScreen from "@/components/loading-screen";
import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
  SellerField,
  StatusPill,
} from "@/components/seller-ui";
import { getErrorMessage } from "@/lib/error-utils";
import {
  disconnectSellerShipping,
  loadSellerShipping,
  saveSellerShippingDefaults,
  startSellerShippingOAuth,
} from "@/lib/shipping-runtime";
import { useSessionStore } from "@/stores/session-store";
import { sellerThemeTokens } from "@/theme/tokens";

const CARRIERS = ["USPS", "UPS", "FEDEX", "DHL_EXPRESS", "CANADA_POST"];
const EMPTY_DEFAULTS: SellerShippingDefaults = {
  fromName: null,
  fromCompany: null,
  fromStreet1: null,
  fromStreet2: null,
  fromCity: null,
  fromState: null,
  fromZip: null,
  fromCountry: "US",
  fromPhone: null,
  fromEmail: null,
  preferredCarriers: ["USPS"],
  autoPurchaseLabels: true,
};

export default function SellerShippingScreen() {
  const session = useSessionStore((state) => state.session);
  const query = useQuery({
    queryKey: ["seller-shipping", session?.pubkey],
    enabled: Boolean(session),
    queryFn: () => {
      if (!session) throw new Error("Seller session is required.");
      return loadSellerShipping(session);
    },
  });
  const [defaults, setDefaults] = useState(EMPTY_DEFAULTS);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (query.data) setDefaults(query.data.defaults ?? EMPTY_DEFAULTS);
  }, [query.data]);

  if (!session) return null;
  if (query.isLoading && !query.data) {
    return <LoadingScreen message="Loading shipping workspace..." />;
  }

  const updateText = (key: keyof SellerShippingDefaults, value: string) =>
    setDefaults((current) => ({ ...current, [key]: value || null }));

  const toggleCarrier = (carrier: string) => {
    setDefaults((current) => {
      const selected = new Set(current.preferredCarriers);
      if (selected.has(carrier)) selected.delete(carrier);
      else selected.add(carrier);
      return {
        ...current,
        preferredCarriers: selected.size > 0 ? Array.from(selected) : ["USPS"],
      };
    });
  };

  const run = async (action: () => Promise<unknown>, success: string) => {
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(success);
      await query.refetch();
    } catch (cause) {
      setError(getErrorMessage(cause, "Shipping action failed."));
    } finally {
      setWorking(false);
    }
  };

  const connect = () =>
    run(async () => {
      const authorizeUrl = await startSellerShippingOAuth(session);
      const returnUrl = Linking.createURL("shipping");
      const result = await WebBrowser.openAuthSessionAsync(
        authorizeUrl,
        returnUrl
      );
      if (result.type !== "success") {
        throw new Error("Shippo connection was canceled.");
      }
    }, "Shippo is connected.");

  const disconnect = () => {
    Alert.alert(
      "Disconnect Shippo?",
      "Existing labels remain available, but new labels cannot be purchased.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () => {
            void run(
              () => disconnectSellerShipping(session),
              "Shippo was disconnected."
            );
          },
        },
      ]
    );
  };

  const connection = query.data?.connection;
  const labels = query.data?.labels ?? [];

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Seller shipping"
        title="Shipping"
        description="Connect your carrier account, set dispatch defaults, and access purchased labels."
      />

      {query.isError ? (
        <Text style={styles.error}>
          {getErrorMessage(query.error, "Shipping could not be loaded.")}
        </Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {message ? <Text style={styles.success}>{message}</Text> : null}

      <SellerCard
        title="Shippo account"
        description="Label charges are billed directly by Shippo to your connected seller account."
      >
        <StatusPill
          tone={connection?.connected ? "success" : "warning"}
          label={connection?.connected ? "Connected" : "Not connected"}
        />
        {connection?.configured === false ? (
          <Text style={styles.helper}>
            Shipping is not configured on this server.
          </Text>
        ) : connection?.connected ? (
          <ActionButton
            label="Disconnect Shippo"
            variant="secondary"
            loading={working}
            onPress={disconnect}
          />
        ) : (
          <ActionButton
            label="Connect Shippo"
            loading={working}
            onPress={() => void connect()}
          />
        )}
      </SellerCard>

      <SellerCard
        title="Ship-from defaults"
        description="These details are used for seller-created rate quotes and labels."
      >
        <SellerField
          label="Name"
          value={defaults.fromName ?? ""}
          onChangeText={(v) => updateText("fromName", v)}
        />
        <SellerField
          label="Company (optional)"
          value={defaults.fromCompany ?? ""}
          onChangeText={(v) => updateText("fromCompany", v)}
        />
        <SellerField
          label="Street address"
          value={defaults.fromStreet1 ?? ""}
          onChangeText={(v) => updateText("fromStreet1", v)}
        />
        <SellerField
          label="Unit (optional)"
          value={defaults.fromStreet2 ?? ""}
          onChangeText={(v) => updateText("fromStreet2", v)}
        />
        <SellerField
          label="City"
          value={defaults.fromCity ?? ""}
          onChangeText={(v) => updateText("fromCity", v)}
        />
        <View style={styles.row}>
          <View style={styles.flex}>
            <SellerField
              label="State"
              value={defaults.fromState ?? ""}
              autoCapitalize="characters"
              onChangeText={(v) => updateText("fromState", v)}
            />
          </View>
          <View style={styles.flex}>
            <SellerField
              label="Postal code"
              value={defaults.fromZip ?? ""}
              onChangeText={(v) => updateText("fromZip", v)}
            />
          </View>
        </View>
        <SellerField
          label="Country"
          value={defaults.fromCountry ?? ""}
          autoCapitalize="characters"
          onChangeText={(v) => updateText("fromCountry", v)}
        />
        <SellerField
          label="Phone (optional)"
          value={defaults.fromPhone ?? ""}
          keyboardType="phone-pad"
          onChangeText={(v) => updateText("fromPhone", v)}
        />
        <SellerField
          label="Email (optional)"
          value={defaults.fromEmail ?? ""}
          keyboardType="email-address"
          autoCapitalize="none"
          onChangeText={(v) => updateText("fromEmail", v)}
        />

        <Text style={styles.sectionLabel}>Preferred carriers</Text>
        <View style={styles.chips}>
          {CARRIERS.map((carrier) => {
            const selected = defaults.preferredCarriers.includes(carrier);
            return (
              <Pressable
                key={carrier}
                onPress={() => toggleCarrier(carrier)}
                style={[styles.chip, selected ? styles.chipSelected : null]}
              >
                <Text
                  style={[
                    styles.chipText,
                    selected ? styles.chipTextSelected : null,
                  ]}
                >
                  {carrier}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.switchRow}>
          <View style={styles.flex}>
            <Text style={styles.switchTitle}>Automatic labels</Text>
            <Text style={styles.helper}>
              Buy the cheapest preferred-carrier label after eligible paid
              orders.
            </Text>
          </View>
          <Switch
            value={defaults.autoPurchaseLabels}
            onValueChange={(value) =>
              setDefaults((current) => ({
                ...current,
                autoPurchaseLabels: value,
              }))
            }
          />
        </View>
        <ActionButton
          label="Save shipping defaults"
          loading={working}
          onPress={() =>
            void run(
              () => saveSellerShippingDefaults(session, defaults),
              "Shipping defaults saved."
            )
          }
        />
      </SellerCard>

      <SellerCard
        title="Purchased labels"
        description="Recent outbound labels remain available here after app restarts."
      >
        {labels.length === 0 ? (
          <Text style={styles.helper}>No labels purchased yet.</Text>
        ) : (
          labels.map((label) => (
            <View
              key={`${label.shipmentId}:${label.id ?? "pending"}`}
              style={styles.labelRow}
            >
              <View style={styles.flex}>
                <Text style={styles.labelTitle}>
                  {label.carrier || "Carrier pending"}
                  {label.service ? ` ${label.service}` : ""}
                </Text>
                <Text style={styles.helper}>
                  Order {label.orderId ?? "not linked"} ·{" "}
                  {label.trackingCode || "Tracking pending"}
                </Text>
              </View>
              <ActionButton
                label="Open label"
                variant="secondary"
                disabled={!isSafeShippingUrl(label.labelUrl)}
                onPress={() => {
                  if (isSafeShippingUrl(label.labelUrl)) {
                    void Linking.openURL(label.labelUrl);
                  }
                }}
              />
            </View>
          ))
        )}
      </SellerCard>
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 12 },
  flex: { flex: 1 },
  error: { color: sellerThemeTokens.danger, fontSize: 14, lineHeight: 20 },
  success: { color: sellerThemeTokens.success, fontSize: 14, lineHeight: 20 },
  helper: { color: sellerThemeTokens.mutedText, fontSize: 13, lineHeight: 19 },
  sectionLabel: {
    color: sellerThemeTokens.text,
    fontSize: 14,
    fontWeight: "700",
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: sellerThemeTokens.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipSelected: {
    backgroundColor: sellerThemeTokens.primary,
    borderColor: sellerThemeTokens.primary,
  },
  chipText: { color: sellerThemeTokens.text, fontWeight: "600" },
  chipTextSelected: { color: sellerThemeTokens.surface },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  switchTitle: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontWeight: "700",
  },
  labelRow: {
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: sellerThemeTokens.border,
    paddingTop: 14,
  },
  labelTitle: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontWeight: "700",
  },
});
