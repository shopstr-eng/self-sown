import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";

import {
  ActionButton,
  EmptyState,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
  SellerField,
  StatusPill,
} from "@/components/seller-ui";
import LoadingScreen from "@/components/loading-screen";
import { getErrorMessage } from "@/lib/error-utils";
import {
  deleteAddress,
  getSavedAddresses,
  saveAddress,
  setDefaultAddress,
  validateSavedAddressDraft,
  type SavedAddress,
  type SavedAddressDraft,
  type SavedAddressValidationErrors,
} from "@/lib/saved-addresses";
import { useSessionStore } from "@/stores/session-store";
import { sellerThemeTokens } from "@/theme/tokens";

const EMPTY_DRAFT: SavedAddressDraft = {
  label: "",
  name: "",
  address: "",
  unit: "",
  city: "",
  state: "",
  zip: "",
  country: "",
  isDefault: false,
};

export default function SavedAddressesScreen() {
  const session = useSessionStore((state) => state.session);

  const [isLoaded, setIsLoaded] = useState(false);
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<SavedAddressDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<SavedAddressValidationErrors>({});
  const [saving, setSaving] = useState(false);

  const pubkey = session?.pubkey;

  const refresh = useCallback(async () => {
    if (!pubkey) {
      setIsLoaded(true);
      return;
    }
    try {
      const next = await getSavedAddresses(pubkey);
      setAddresses(next);
      setLoadError("");
    } catch (caughtError) {
      setLoadError(
        getErrorMessage(caughtError, "Saved addresses could not be loaded.")
      );
    } finally {
      setIsLoaded(true);
    }
  }, [pubkey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!session) {
    return null;
  }

  if (!isLoaded) {
    return <LoadingScreen message="Loading saved addresses..." />;
  }

  const defaultCount = addresses.filter((address) => address.isDefault).length;
  // Web parity: the sole default address cannot be unset, only replaced.
  const editingExisting = Boolean(draft.id);
  const isOnlyDefault = Boolean(
    draft.id && draft.isDefault && defaultCount === 1 && editingExisting
  );

  const handleAddAddress = () => {
    setDraft(EMPTY_DRAFT);
    setErrors({});
    setActionError("");
    setShowForm(true);
  };

  const handleEditAddress = (address: SavedAddress) => {
    setDraft({ ...address });
    setErrors({});
    setActionError("");
    setShowForm(true);
  };

  const handleCancelForm = () => {
    setShowForm(false);
    setDraft(EMPTY_DRAFT);
    setErrors({});
  };

  const handleFieldChange = (
    field: keyof SavedAddressDraft,
    value: string | boolean
  ) => {
    setDraft((current) => ({ ...current, [field]: value }));
    if (typeof value === "string") {
      setErrors((current) => ({ ...current, [field]: undefined }));
    }
  };

  const handleSave = async () => {
    const nextErrors = validateSavedAddressDraft(draft);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setSaving(true);
    setActionError("");
    try {
      const next = await saveAddress(session.pubkey, {
        ...draft,
        label: draft.label.trim(),
        name: draft.name.trim(),
        address: draft.address.trim(),
        unit: draft.unit?.trim() ?? "",
        city: draft.city.trim(),
        state: draft.state.trim(),
        zip: draft.zip.trim(),
        country: draft.country.trim(),
        // Never unset the only default; keep it and let the user pick another.
        isDefault: isOnlyDefault ? true : draft.isDefault,
      });
      setAddresses(next);
      setShowForm(false);
      setDraft(EMPTY_DRAFT);
      setErrors({});
    } catch (caughtError) {
      setActionError(
        getErrorMessage(caughtError, "The address could not be saved.")
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setActionError("");
    try {
      setAddresses(await deleteAddress(session.pubkey, id));
    } catch (caughtError) {
      setActionError(
        getErrorMessage(caughtError, "The address could not be deleted.")
      );
    }
  };

  const handleSetDefault = async (id: string) => {
    setActionError("");
    try {
      setAddresses(await setDefaultAddress(session.pubkey, id));
    } catch (caughtError) {
      setActionError(
        getErrorMessage(caughtError, "The default address could not be set.")
      );
    }
  };

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Settings"
        title="Saved addresses"
        description="Manage the shipping addresses you can reuse during checkout. They are stored locally on this device."
      />

      {loadError ? (
        <SellerCard title="Could not load saved addresses">
          <Text style={styles.errorText}>{loadError}</Text>
          <ActionButton
            label="Retry"
            onPress={() => void refresh()}
            variant="secondary"
          />
        </SellerCard>
      ) : null}

      <SellerCard title="Your addresses">
        {addresses.length === 0 && !loadError ? (
          <EmptyState
            title="No saved addresses"
            description="Add an address to speed up checkout."
          />
        ) : (
          addresses.map((address) => (
            <View key={address.id} style={styles.addressRow}>
              <View style={styles.addressHeader}>
                <Text style={styles.addressLabel}>{address.label}</Text>
                {address.isDefault ? (
                  <StatusPill tone="success" label="Default" />
                ) : null}
              </View>
              <Text style={styles.addressText}>{address.name}</Text>
              <Text style={styles.addressText}>
                {address.address}
                {address.unit ? `, ${address.unit}` : ""}
              </Text>
              <Text style={styles.addressText}>
                {address.city}, {address.state} {address.zip}
              </Text>
              <Text style={styles.addressText}>{address.country}</Text>
              <View style={styles.addressActions}>
                <ActionButton
                  label="Edit"
                  onPress={() => handleEditAddress(address)}
                  variant="secondary"
                />
                {!address.isDefault ? (
                  <ActionButton
                    label="Make default"
                    onPress={() => void handleSetDefault(address.id)}
                    variant="secondary"
                  />
                ) : null}
                <ActionButton
                  label="Delete"
                  onPress={() => void handleDelete(address.id)}
                  variant="secondary"
                />
              </View>
            </View>
          ))
        )}
        {actionError && !showForm ? (
          <Text style={styles.errorText}>{actionError}</Text>
        ) : null}
        {!showForm ? (
          <ActionButton label="Add address" onPress={handleAddAddress} />
        ) : null}
      </SellerCard>

      {showForm ? (
        <SellerCard title={editingExisting ? "Edit address" : "Add address"}>
          <SellerField
            label="Address label"
            value={draft.label}
            onChangeText={(value) => handleFieldChange("label", value)}
            placeholder="e.g. Home, Office"
            error={errors.label}
          />
          <SellerField
            label="Full name"
            value={draft.name}
            onChangeText={(value) => handleFieldChange("name", value)}
            error={errors.name}
          />
          <SellerField
            label="Street address"
            value={draft.address}
            onChangeText={(value) => handleFieldChange("address", value)}
            error={errors.address}
          />
          <SellerField
            label="Apt/Suite (optional)"
            value={draft.unit ?? ""}
            onChangeText={(value) => handleFieldChange("unit", value)}
          />
          <SellerField
            label="City"
            value={draft.city}
            onChangeText={(value) => handleFieldChange("city", value)}
            error={errors.city}
          />
          <SellerField
            label="State"
            value={draft.state}
            onChangeText={(value) => handleFieldChange("state", value)}
            error={errors.state}
          />
          <SellerField
            label="Zip/Postal code"
            value={draft.zip}
            onChangeText={(value) => handleFieldChange("zip", value)}
            error={errors.zip}
            autoCapitalize="none"
          />
          <SellerField
            label="Country"
            value={draft.country}
            onChangeText={(value) => handleFieldChange("country", value)}
            error={errors.country}
          />

          <View style={styles.defaultRow}>
            <Text style={styles.defaultLabel}>Set as default address</Text>
            <Switch
              value={isOnlyDefault ? true : draft.isDefault}
              disabled={isOnlyDefault}
              onValueChange={(value) => handleFieldChange("isDefault", value)}
              trackColor={{
                false: sellerThemeTokens.subduedSurface,
                true: sellerThemeTokens.primary,
              }}
              thumbColor={sellerThemeTokens.surface}
            />
          </View>
          {isOnlyDefault ? (
            <Text style={styles.helperText}>
              This is your only default address and cannot be unset.
            </Text>
          ) : null}

          {actionError ? (
            <Text style={styles.errorText}>{actionError}</Text>
          ) : null}
          <ActionButton
            label="Save address"
            onPress={() => void handleSave()}
            loading={saving}
          />
          <ActionButton
            label="Cancel"
            onPress={handleCancelForm}
            variant="secondary"
          />
        </SellerCard>
      ) : null}
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  addressRow: {
    gap: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.border,
    borderRadius: 6,
    backgroundColor: sellerThemeTokens.surface,
    padding: 12,
  },
  addressHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  addressLabel: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontWeight: "700",
  },
  addressText: {
    color: sellerThemeTokens.text,
    fontSize: 14,
    lineHeight: 20,
  },
  addressActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 4,
  },
  defaultRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  defaultLabel: {
    color: sellerThemeTokens.text,
    fontSize: 14,
    fontWeight: "600",
  },
  helperText: {
    color: sellerThemeTokens.mutedText,
    fontSize: 14,
    lineHeight: 21,
  },
  errorText: {
    color: sellerThemeTokens.danger,
    fontSize: 14,
    lineHeight: 20,
  },
});
