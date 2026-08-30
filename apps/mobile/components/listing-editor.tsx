import { useMemo } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import {
  getKnownSellerListingCategories,
  isPickupShippingOption,
  requiresShippingCost,
  SHIPPING_OPTIONS,
  type SellerListingDraft,
  type SellerListingDraftValidationErrors,
  type SellerListingStatus,
} from "@milk-market/domain";

import { ActionButton, SellerCard, SellerField } from "@/components/seller-ui";
import { sellerThemeTokens } from "@/theme/tokens";

const STATUS_OPTIONS: SellerListingStatus[] = ["active", "inactive"];

export function ListingEditor({
  draft,
  errors,
  submitLabel,
  submitLoading = false,
  deleteLoading = false,
  imageLoading = false,
  actionError,
  actionMessage,
  onChange,
  onSubmit,
  onPickImages,
  onDelete,
}: {
  draft: SellerListingDraft;
  errors: SellerListingDraftValidationErrors;
  submitLabel: string;
  submitLoading?: boolean;
  deleteLoading?: boolean;
  imageLoading?: boolean;
  actionError?: string;
  actionMessage?: string;
  onChange: (nextDraft: SellerListingDraft) => void;
  onSubmit: () => void;
  onPickImages: () => void;
  onDelete?: () => void;
}) {
  const knownCategories = useMemo(() => getKnownSellerListingCategories(), []);
  const customCategories = draft.categories.filter(
    (category) => !knownCategories.includes(category)
  );

  const toggleKnownCategory = (category: string) => {
    const nextCategories = draft.categories.includes(category)
      ? draft.categories.filter((value) => value !== category)
      : [...draft.categories, category];
    onChange({
      ...draft,
      categories: nextCategories,
    });
  };

  const updatePickupLocation = (index: number, value: string) => {
    const nextPickupLocations = [...draft.pickupLocations];
    nextPickupLocations[index] = value;
    onChange({
      ...draft,
      pickupLocations: nextPickupLocations,
    });
  };

  const addPickupLocation = () => {
    onChange({
      ...draft,
      pickupLocations: [...draft.pickupLocations, ""],
    });
  };

  const removePickupLocation = (index: number) => {
    onChange({
      ...draft,
      pickupLocations: draft.pickupLocations.filter(
        (_, itemIndex) => itemIndex !== index
      ),
    });
  };

  const removeImage = (imageUrl: string) => {
    onChange({
      ...draft,
      images: draft.images.filter((image) => image !== imageUrl),
    });
  };

  const removeCustomCategory = (category: string) => {
    onChange({
      ...draft,
      categories: draft.categories.filter((value) => value !== category),
    });
  };

  return (
    <View style={styles.editor}>
      <SellerCard
        title="Listing basics"
        description="Phase 3 keeps mobile listing management focused on the core fields we can safely publish and edit on-device."
      >
        <SellerField
          label="Title"
          value={draft.title}
          placeholder="Fresh raw milk"
          onChangeText={(value) => onChange({ ...draft, title: value })}
          error={errors.title}
        />
        <SellerField
          label="Description"
          value={draft.description}
          placeholder="Tell buyers what makes this listing special."
          onChangeText={(value) => onChange({ ...draft, description: value })}
          multiline
          error={errors.description}
        />
        <View style={styles.row}>
          <View style={styles.flexField}>
            <SellerField
              label="Price"
              value={draft.price}
              placeholder="12.50"
              onChangeText={(value) => onChange({ ...draft, price: value })}
              keyboardType="decimal-pad"
              error={errors.price}
            />
          </View>
          <View style={styles.currencyField}>
            <SellerField
              label="Currency"
              value={draft.currency}
              placeholder="USD"
              onChangeText={(value) =>
                onChange({ ...draft, currency: value.toUpperCase() })
              }
              autoCapitalize="characters"
              error={errors.currency}
            />
          </View>
        </View>
        <SellerField
          label="Location"
          value={draft.location}
          placeholder="Jaipur, Rajasthan"
          onChangeText={(value) => onChange({ ...draft, location: value })}
          error={errors.location}
        />
        <SellerField
          label="Quantity"
          value={draft.quantity}
          placeholder="Optional"
          onChangeText={(value) => onChange({ ...draft, quantity: value })}
          keyboardType="number-pad"
          error={errors.quantity}
        />
      </SellerCard>

      <SellerCard
        title="Categories"
        description="Known Milk Market categories stay tap-friendly on mobile. Existing custom tags are preserved and can still be removed."
      >
        <View style={styles.chipWrap}>
          {knownCategories.map((category) => {
            const selected = draft.categories.includes(category);
            return (
              <Pressable
                key={category}
                onPress={() => toggleKnownCategory(category)}
                style={[
                  styles.chip,
                  selected ? styles.chipSelected : styles.chipIdle,
                ]}
              >
                <Text
                  style={[
                    styles.chipLabel,
                    selected ? styles.chipLabelSelected : null,
                  ]}
                >
                  {category}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {customCategories.length > 0 ? (
          <View style={styles.customTagWrap}>
            <Text style={styles.sectionLabel}>
              Other tags already on this listing
            </Text>
            <View style={styles.chipWrap}>
              {customCategories.map((category) => (
                <Pressable
                  key={category}
                  onPress={() => removeCustomCategory(category)}
                  style={[styles.chip, styles.chipCustom]}
                >
                  <Text style={styles.chipLabel}>{category} x</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
        {errors.categories ? (
          <Text style={styles.errorText}>{errors.categories}</Text>
        ) : null}
      </SellerCard>

      <SellerCard
        title="Fulfillment"
        description="Shipping and pickup tags map directly to the current listing parser, so mobile and web stay compatible."
      >
        <Text style={styles.sectionLabel}>Shipping option</Text>
        <View style={styles.chipWrap}>
          {SHIPPING_OPTIONS.map((option) => {
            const selected = draft.shippingType === option;
            return (
              <Pressable
                key={option}
                onPress={() => onChange({ ...draft, shippingType: option })}
                style={[
                  styles.chip,
                  selected ? styles.chipSelected : styles.chipIdle,
                ]}
              >
                <Text
                  style={[
                    styles.chipLabel,
                    selected ? styles.chipLabelSelected : null,
                  ]}
                >
                  {option}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {errors.shippingType ? (
          <Text style={styles.errorText}>{errors.shippingType}</Text>
        ) : null}

        {requiresShippingCost(draft.shippingType) ? (
          <SellerField
            label="Shipping cost"
            value={draft.shippingCost}
            placeholder="0"
            onChangeText={(value) =>
              onChange({ ...draft, shippingCost: value })
            }
            keyboardType="decimal-pad"
            error={errors.shippingCost}
          />
        ) : null}

        {isPickupShippingOption(draft.shippingType) ? (
          <View style={styles.pickupWrap}>
            <Text style={styles.sectionLabel}>Pickup locations</Text>
            {draft.pickupLocations.length === 0 ? (
              <Text style={styles.helperText}>
                Add at least one pickup location for pickup-based shipping.
              </Text>
            ) : null}
            {draft.pickupLocations.map((location, index) => (
              <View key={`pickup-${index}`} style={styles.pickupRow}>
                <View style={styles.flexField}>
                  <SellerField
                    label={`Pickup location ${index + 1}`}
                    value={location}
                    placeholder="Farm gate pickup"
                    onChangeText={(value) => updatePickupLocation(index, value)}
                  />
                </View>
                <View style={styles.pickupRemoveButton}>
                  <ActionButton
                    label="Remove"
                    onPress={() => removePickupLocation(index)}
                    variant="secondary"
                  />
                </View>
              </View>
            ))}
            <ActionButton
              label="Add pickup location"
              onPress={addPickupLocation}
              variant="secondary"
            />
            {errors.pickupLocations ? (
              <Text style={styles.errorText}>{errors.pickupLocations}</Text>
            ) : null}
          </View>
        ) : null}
      </SellerCard>

      <SellerCard
        title="Images"
        description="Images upload through the default Blossom server path used by Milk Market."
      >
        <ActionButton
          label="Add listing images"
          onPress={onPickImages}
          variant="secondary"
          loading={imageLoading}
        />
        {errors.images ? (
          <Text style={styles.errorText}>{errors.images}</Text>
        ) : null}
        {draft.images.length === 0 ? (
          <Text style={styles.helperText}>
            Add at least one image before publishing this listing.
          </Text>
        ) : (
          <View style={styles.imageList}>
            {draft.images.map((imageUrl) => (
              <View key={imageUrl} style={styles.imageCard}>
                <Image source={{ uri: imageUrl }} style={styles.imagePreview} />
                <Text numberOfLines={2} style={styles.imageUrl}>
                  {imageUrl}
                </Text>
                <ActionButton
                  label="Remove image"
                  onPress={() => removeImage(imageUrl)}
                  variant="secondary"
                />
              </View>
            ))}
          </View>
        )}
      </SellerCard>

      <SellerCard
        title="Listing status"
        description="Publish and unpublish are modeled through the existing listing status tag."
      >
        <View style={styles.chipWrap}>
          {STATUS_OPTIONS.map((status) => {
            const selected = draft.status === status;
            return (
              <Pressable
                key={status}
                onPress={() => onChange({ ...draft, status })}
                style={[
                  styles.chip,
                  selected ? styles.chipSelected : styles.chipIdle,
                ]}
              >
                <Text
                  style={[
                    styles.chipLabel,
                    selected ? styles.chipLabelSelected : null,
                  ]}
                >
                  {status}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {errors.status ? (
          <Text style={styles.errorText}>{errors.status}</Text>
        ) : null}
      </SellerCard>

      {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}
      {actionMessage ? (
        <Text style={styles.successText}>{actionMessage}</Text>
      ) : null}

      <ActionButton
        label={submitLabel}
        onPress={onSubmit}
        loading={submitLoading}
      />
      {onDelete ? (
        <ActionButton
          label="Delete listing"
          onPress={onDelete}
          variant="secondary"
          loading={deleteLoading}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  editor: {
    gap: 16,
  },
  row: {
    flexDirection: "row",
    gap: 12,
  },
  flexField: {
    flex: 1,
  },
  currencyField: {
    width: 120,
  },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
  },
  chipIdle: {
    borderColor: sellerThemeTokens.border,
    backgroundColor: sellerThemeTokens.background,
  },
  chipSelected: {
    borderColor: sellerThemeTokens.primary,
    backgroundColor: sellerThemeTokens.primary,
  },
  chipCustom: {
    borderColor: sellerThemeTokens.border,
    backgroundColor: sellerThemeTokens.subduedSurface,
  },
  chipLabel: {
    color: sellerThemeTokens.text,
    fontSize: 13,
    fontWeight: "700",
  },
  chipLabelSelected: {
    color: sellerThemeTokens.surface,
  },
  sectionLabel: {
    color: sellerThemeTokens.text,
    fontSize: 14,
    fontWeight: "700",
  },
  helperText: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    lineHeight: 18,
  },
  customTagWrap: {
    gap: 10,
  },
  pickupWrap: {
    gap: 10,
  },
  pickupRow: {
    gap: 10,
  },
  pickupRemoveButton: {
    alignSelf: "flex-start",
  },
  imageList: {
    gap: 12,
  },
  imageCard: {
    gap: 10,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: sellerThemeTokens.border,
    backgroundColor: sellerThemeTokens.background,
  },
  imagePreview: {
    width: "100%",
    height: 180,
    borderRadius: 12,
    backgroundColor: sellerThemeTokens.subduedSurface,
  },
  imageUrl: {
    color: sellerThemeTokens.mutedText,
    fontSize: 12,
    lineHeight: 18,
  },
  errorText: {
    color: sellerThemeTokens.danger,
    fontSize: 13,
    lineHeight: 18,
  },
  successText: {
    color: sellerThemeTokens.success,
    fontSize: 13,
    lineHeight: 18,
  },
});
