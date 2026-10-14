import { useEffect, useState } from "react";
import { Image, StyleSheet, Switch, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
  SellerField,
} from "@/components/seller-ui";
import LoadingScreen from "@/components/loading-screen";
import { useSellerBootstrap } from "@/hooks/use-seller-bootstrap";
import { getErrorMessage } from "@/lib/error-utils";
import {
  createEmptyMarketProfileDraft,
  createMarketProfileDraft,
  deriveMarketPaymentPreference,
  describeMarketPaymentPreference,
  FIAT_OPTION_FIELDS,
  resolveMarketProfile,
  saveMarketProfile,
  validateMarketProfileDraft,
  type MarketProfileDraft,
  type MarketProfileValidationErrors,
} from "@/lib/market-profile";
import { pickAndUploadSellerListingImages } from "@/lib/listing-images";
import { useSessionStore } from "@/stores/session-store";
import { sellerThemeTokens } from "@/theme/tokens";

export default function MarketProfileScreen() {
  const queryClient = useQueryClient();
  const session = useSessionStore((state) => state.session);
  const { profileQuery } = useSellerBootstrap(session);
  // acceptBitcoin comes from the seller's shop profile (kind:30019) storefront
  // config, defaulting to true exactly like the web checkout/settings do.
  const acceptBitcoin =
    profileQuery.data?.content.storefront?.acceptBitcoin !== false;

  const marketProfileQuery = useQuery({
    queryKey: ["seller-market-profile", session?.pubkey],
    enabled: Boolean(session),
    queryFn: async () => {
      if (!session) {
        throw new Error("Vendor session is required.");
      }
      return resolveMarketProfile(session.pubkey);
    },
  });

  const [draft, setDraft] = useState<MarketProfileDraft>(
    createEmptyMarketProfileDraft()
  );
  const [existingContent, setExistingContent] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [errors, setErrors] = useState<MarketProfileValidationErrors>({});
  const [isDirty, setIsDirty] = useState(false);
  const [lastHydratedSignature, setLastHydratedSignature] = useState<
    string | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [uploadingPicture, setUploadingPicture] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    if (marketProfileQuery.isLoading || !session) {
      return;
    }

    const resolved = marketProfileQuery.data ?? null;
    const nextDraft = createMarketProfileDraft(resolved?.content);
    const nextSignature = JSON.stringify(nextDraft);

    if (isDirty || lastHydratedSignature === nextSignature) {
      return;
    }

    setDraft(nextDraft);
    setExistingContent(resolved?.content ?? null);
    setErrors({});
    setSaveError("");
    setLastHydratedSignature(nextSignature);
  }, [
    marketProfileQuery.isLoading,
    marketProfileQuery.data,
    session,
    isDirty,
    lastHydratedSignature,
  ]);

  if (!session) {
    return null;
  }

  const loadErrorMessage = marketProfileQuery.error
    ? getErrorMessage(marketProfileQuery.error, "Profile could not be loaded.")
    : "";

  if (marketProfileQuery.isLoading && !lastHydratedSignature) {
    return <LoadingScreen message="Loading market profile..." />;
  }

  if (loadErrorMessage && !lastHydratedSignature) {
    return (
      <ScreenScrollView>
        <ScreenTitle
          eyebrow="Market profile"
          title="Profile unavailable"
          description="Your market profile could not be loaded yet, so the form is paused until we can fetch the current values."
        />
        <SellerCard title="Could not load market profile">
          <Text style={styles.errorText}>{loadErrorMessage}</Text>
          <ActionButton
            label="Retry profile load"
            onPress={() => void marketProfileQuery.refetch()}
            variant="secondary"
            loading={marketProfileQuery.isFetching}
          />
        </SellerCard>
      </ScreenScrollView>
    );
  }

  const handleFieldChange = (
    field: keyof Omit<MarketProfileDraft, "fiatOptions">,
    value: string
  ) => {
    setDraft((currentDraft) => ({ ...currentDraft, [field]: value }));
    setIsDirty(true);
    setErrors((currentErrors) => ({ ...currentErrors, [field]: undefined }));
    setSaveError("");
    setSaveMessage("");
  };

  const handleFiatOptionToggle = (key: string, requiresUsername: boolean) => {
    setDraft((currentDraft) => {
      const nextOptions = { ...currentDraft.fiatOptions };
      if (key in nextOptions) {
        delete nextOptions[key];
      } else {
        nextOptions[key] = requiresUsername ? "" : "available";
      }
      return { ...currentDraft, fiatOptions: nextOptions };
    });
    setIsDirty(true);
    setSaveError("");
    setSaveMessage("");
  };

  const handleFiatOptionUsername = (key: string, value: string) => {
    setDraft((currentDraft) => ({
      ...currentDraft,
      fiatOptions: { ...currentDraft.fiatOptions, [key]: value },
    }));
    setIsDirty(true);
    setSaveError("");
    setSaveMessage("");
  };

  const handleUploadPicture = async () => {
    setUploadingPicture(true);
    setSaveError("");
    try {
      const result = await pickAndUploadSellerListingImages(session);
      if (result.failedFileNames.length > 0) {
        setSaveError(
          `Image upload failed for: ${result.failedFileNames.join(", ")}.`
        );
        return;
      }
      const uploadedUrl = result.uploadedUrls[0];
      if (uploadedUrl) {
        handleFieldChange("picture", uploadedUrl);
      }
    } catch (caughtError) {
      setSaveError(
        getErrorMessage(caughtError, "Profile picture could not be uploaded.")
      );
    } finally {
      setUploadingPicture(false);
    }
  };

  const handleSave = async () => {
    const nextErrors = validateMarketProfileDraft(draft);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setSaving(true);
    setSaveError("");
    setSaveMessage("");

    try {
      await saveMarketProfile(session, existingContent, draft, acceptBitcoin);
      const savedSignature = JSON.stringify(draft);
      setIsDirty(false);
      setLastHydratedSignature(savedSignature);
      setSaveMessage("Market profile saved.");
      await queryClient.invalidateQueries({
        queryKey: ["seller-market-profile", session.pubkey],
      });
    } catch (caughtError) {
      setSaveError(
        getErrorMessage(caughtError, "Market profile could not be saved.")
      );
    } finally {
      setSaving(false);
    }
  };

  const derivedPreference = deriveMarketPaymentPreference(
    draft.lud16,
    acceptBitcoin
  );

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Market profile"
        title="Edit your market profile"
        description="Your public Nostr profile buyers see across marketplaces: name, picture, Lightning address, and payment options."
      />

      <SellerCard
        title="Profile picture"
        description="Upload a new picture or paste an image URL."
      >
        <View style={styles.avatarRow}>
          <Image
            source={{
              uri:
                draft.picture.trim() ||
                `https://robohash.org/${session.pubkey}`,
            }}
            style={styles.avatar}
          />
          <View style={styles.avatarActions}>
            <ActionButton
              label="Upload picture"
              onPress={() => void handleUploadPicture()}
              variant="secondary"
              loading={uploadingPicture}
            />
          </View>
        </View>
        <SellerField
          label="Picture URL"
          value={draft.picture}
          onChangeText={(value) => handleFieldChange("picture", value)}
          placeholder="https://..."
          autoCapitalize="none"
        />
      </SellerCard>

      <SellerCard title="Identity">
        <SellerField
          label="Display name"
          value={draft.displayName}
          onChangeText={(value) => handleFieldChange("displayName", value)}
          placeholder="Add your display name..."
        />
        <SellerField
          label="Username"
          value={draft.username}
          onChangeText={(value) => handleFieldChange("username", value)}
          placeholder="Add your username..."
          autoCapitalize="none"
        />
        <SellerField
          label="Nostr address (optional)"
          value={draft.nip05}
          onChangeText={(value) => handleFieldChange("nip05", value)}
          placeholder="Add your NIP-05 address..."
          autoCapitalize="none"
        />
        <SellerField
          label="Lightning address (optional)"
          value={draft.lud16}
          onChangeText={(value) => handleFieldChange("lud16", value)}
          placeholder="Add your Lightning address..."
          autoCapitalize="none"
        />
        <View style={styles.fieldWrap}>
          <Text style={styles.fieldLabel}>Payment preference</Text>
          <View style={styles.derivedPreference}>
            <Text style={styles.derivedPreferenceText}>
              {describeMarketPaymentPreference(derivedPreference)}
            </Text>
          </View>
          <Text style={styles.helperText}>
            Set automatically: Lightning when you have a Lightning address,
            Cashu when no address is set, and Local Currency (Fiat) when Bitcoin
            payments are turned off in your shop settings.
          </Text>
        </View>
      </SellerCard>

      <SellerCard
        title="Fiat payment options"
        description="Toggle the options you accept and add your username or tag where needed."
      >
        {FIAT_OPTION_FIELDS.map((option) => {
          const enabled = option.key in draft.fiatOptions;
          return (
            <View key={option.key} style={styles.fiatOption}>
              <View style={styles.fiatOptionRow}>
                <Text style={styles.fiatOptionLabel}>{option.label}</Text>
                <Switch
                  value={enabled}
                  onValueChange={() =>
                    handleFiatOptionToggle(option.key, option.requiresUsername)
                  }
                  trackColor={{
                    false: sellerThemeTokens.subduedSurface,
                    true: sellerThemeTokens.primary,
                  }}
                  thumbColor={sellerThemeTokens.surface}
                />
              </View>
              {enabled && option.requiresUsername ? (
                <SellerField
                  label={`${option.label} username/tag`}
                  value={draft.fiatOptions[option.key] ?? ""}
                  onChangeText={(value) =>
                    handleFiatOptionUsername(option.key, value)
                  }
                  placeholder={`Enter your ${option.label} username/tag`}
                  autoCapitalize="none"
                />
              ) : null}
            </View>
          );
        })}
      </SellerCard>

      <SellerCard
        title="Self-sown donation (%)"
        description="This donation helps fund Self-sown and keep the marketplace running. You can change it at any time."
      >
        <SellerField
          label="Donation percent"
          value={draft.donationPercent}
          onChangeText={(value) => handleFieldChange("donationPercent", value)}
          placeholder="0"
          keyboardType="decimal-pad"
          error={errors.donationPercent}
        />
        {draft.lud16.trim() ? (
          <Text style={styles.helperText}>
            Note: Lightning payments go directly to your Lightning address, so
            this donation doesn't apply to them.
          </Text>
        ) : null}

        {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
        {saveMessage ? (
          <Text style={styles.successText}>{saveMessage}</Text>
        ) : null}
        <ActionButton
          label="Save market profile"
          onPress={() => void handleSave()}
          loading={saving}
          disabled={marketProfileQuery.isFetching}
        />
      </SellerCard>
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  avatarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    backgroundColor: sellerThemeTokens.subduedSurface,
  },
  avatarActions: {
    flex: 1,
  },
  fieldWrap: {
    gap: 8,
  },
  fieldLabel: {
    color: sellerThemeTokens.text,
    fontSize: 14,
    fontWeight: "700",
  },
  derivedPreference: {
    minHeight: 52,
    justifyContent: "center",
    borderWidth: 2,
    borderColor: sellerThemeTokens.border,
    borderRadius: 6,
    backgroundColor: sellerThemeTokens.subduedSurface,
    paddingHorizontal: 14,
  },
  derivedPreferenceText: {
    color: sellerThemeTokens.text,
    fontSize: 15,
  },
  fiatOption: {
    gap: 10,
  },
  fiatOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  fiatOptionLabel: {
    color: sellerThemeTokens.text,
    fontSize: 15,
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
  successText: {
    color: sellerThemeTokens.success,
    fontSize: 14,
    lineHeight: 20,
  },
});
