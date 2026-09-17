import { useState } from "react";
import { Alert, Image, Pressable, StyleSheet, Text, View } from "react-native";
import {
  SELLER_SIZE_VALUES,
  SELLER_VOLUME_VALUES,
  SELLER_WEIGHT_VALUES,
  type SellerListingOptionsDraft,
  type ListingOptionsErrors,
  type ListingOptionsIssue,
} from "@milk-market/domain";
import { ActionButton, SellerCard, SellerField } from "@/components/seller-ui";
import { removeListingOption } from "@/lib/listing-editor-state";
import { catalogTheme as theme } from "./catalog-appearance";

export type ListingOptionsEditorProps = {
  value: SellerListingOptionsDraft;
  errors: ListingOptionsErrors;
  issues: ListingOptionsIssue[];
  productImages: string[];
  disabled: boolean;
  currency: string;
  onChange(value: SellerListingOptionsDraft): void;
};
export function ListingOptionChip({
  label,
  selected = false,
  disabled = false,
  onPress,
}: {
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.chip,
        selected && styles.selected,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.chipText, selected && styles.selectedText]}>
        {label}
      </Text>
    </Pressable>
  );
}
export function ListingOptionsEditor({
  value,
  errors,
  issues,
  productImages,
  disabled,
  currency,
  onChange,
}: ListingOptionsEditorProps) {
  const [choiceInput, setChoiceInput] = useState("");
  const remove = (
    group: "sizes" | "volumes" | "weights" | "choices",
    label: string
  ) => {
    const apply = () => onChange(removeListingOption(value, group, label));
    if (
      (group === "volumes" || group === "weights") &&
      value.bundles.some((tier) => tier.optionLabel === label)
    )
      Alert.alert(
        "Remove option and bundles?",
        `Removing ${label} will also remove its bundle prices.`,
        [
          { text: "Keep option", style: "cancel" },
          { text: "Remove", style: "destructive", onPress: apply },
        ]
      );
    else apply();
  };
  return (
    <>
      {(
        [
          ["volumes", "Volume options", SELLER_VOLUME_VALUES],
          ["weights", "Weight options", SELLER_WEIGHT_VALUES],
          ["sizes", "Size quantities", SELLER_SIZE_VALUES],
        ] as const
      ).map(([group, title, choices]) => {
        const issue = issues.find((issue) => issue.group === group);
        const rows = value[group];
        return (
          <SellerCard
            key={group}
            title={title}
            description={
              group === "sizes"
                ? "Choose sizes and set their listing quantities. Zero means out of stock."
                : "Each selected option has its own price."
            }
          >
            {issue ? (
              <Text style={styles.note}>{issue.message}</Text>
            ) : (
              <View style={styles.wrap}>
                {choices.map((label) => (
                  <ListingOptionChip
                    key={label}
                    label={label}
                    selected={rows.some((row) => row.label === label)}
                    disabled={disabled}
                    onPress={() =>
                      rows.some((row) => row.label === label)
                        ? remove(group, label)
                        : onChange({
                            ...value,
                            [group]: [
                              ...rows,
                              group === "sizes"
                                ? { label, quantity: "0" }
                                : { label, price: "" },
                            ],
                          })
                    }
                  />
                ))}
              </View>
            )}
            <View
              pointerEvents={disabled || issue ? "none" : "auto"}
              accessibilityElementsHidden={false}
            >
              {rows.map((row, index) => (
                <View key={`${group}-${index}`} style={styles.optionRow}>
                  <View style={styles.grow}>
                    <SellerField
                      editable={!disabled && !issue}
                      label={`${row.label} ${"quantity" in row ? "quantity" : `price (${currency})`}`}
                      value={"quantity" in row ? row.quantity : row.price}
                      keyboardType={
                        "quantity" in row ? "number-pad" : "decimal-pad"
                      }
                      error={
                        errors[
                          `${group}.${index}.${"quantity" in row ? "quantity" : "price"}`
                        ] ?? errors[`${group}.${index}.label`]
                      }
                      onChangeText={(text) =>
                        onChange({
                          ...value,
                          [group]: rows.map((item, i) =>
                            i === index
                              ? {
                                  ...item,
                                  ...("quantity" in item
                                    ? { quantity: text }
                                    : { price: text }),
                                }
                              : item
                          ),
                        })
                      }
                    />
                  </View>
                  {!issue && (
                    <ListingOptionChip
                      label={`Remove ${row.label}`}
                      disabled={disabled}
                      onPress={() => remove(group, row.label)}
                    />
                  )}
                </View>
              ))}
            </View>
            {errors[group] ? (
              <Text style={styles.error}>{errors[group]}</Text>
            ) : null}
          </SellerCard>
        );
      })}
      <SellerCard
        title="Custom choices"
        description="Offer a flavor, color or style. These choices do not change price, shipping or stock."
      >
        {issues.some((issue) => issue.group === "choices") ? (
          <Text style={styles.note}>
            {issues.find((issue) => issue.group === "choices")!.message}
          </Text>
        ) : (
          <View
            style={styles.section}
            pointerEvents={disabled ? "none" : "auto"}
          >
            <SellerField
              label="Choice name (optional)"
              placeholder="Flavor"
              value={value.choiceLabel}
              onChangeText={(choiceLabel) =>
                onChange({ ...value, choiceLabel })
              }
            />
            <View style={styles.wrap}>
              {(["buttons", "dropdown"] as const).map((choiceDisplay) => (
                <ListingOptionChip
                  key={choiceDisplay}
                  label={choiceDisplay === "buttons" ? "Buttons" : "Dropdown"}
                  selected={value.choiceDisplay === choiceDisplay}
                  onPress={() => onChange({ ...value, choiceDisplay })}
                />
              ))}
            </View>
            {value.choices.map((choice, index) => (
              <View key={index} style={styles.choice}>
                <SellerField
                  label={`Choice ${index + 1}`}
                  value={choice.label}
                  error={errors[`choices.${index}.label`]}
                  onChangeText={(label) =>
                    onChange({
                      ...value,
                      choices: value.choices.map((item, i) =>
                        i === index ? { ...item, label } : item
                      ),
                    })
                  }
                />
                {choice.imageUrl ? (
                  <Image
                    accessibilityLabel={`${choice.label} image`}
                    source={{ uri: choice.imageUrl }}
                    style={styles.image}
                  />
                ) : null}
                <Text style={styles.note}>
                  Optional image — choose from your product photos.
                </Text>
                <View style={styles.wrap}>
                  <ListingOptionChip
                    label="No image"
                    selected={!choice.imageUrl}
                    onPress={() =>
                      onChange({
                        ...value,
                        choices: value.choices.map((item, i) =>
                          i === index ? { label: item.label } : item
                        ),
                      })
                    }
                  />
                  {productImages.map((imageUrl, imageIndex) => (
                    <Pressable
                      key={`${imageIndex}:${imageUrl}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Use photo ${imageIndex + 1} for ${choice.label}`}
                      accessibilityState={{
                        selected: choice.imageUrl === imageUrl,
                      }}
                      onPress={() =>
                        onChange({
                          ...value,
                          choices: value.choices.map((item, i) =>
                            i === index ? { ...item, imageUrl } : item
                          ),
                        })
                      }
                      style={[
                        styles.photoButton,
                        choice.imageUrl === imageUrl && styles.photoSelected,
                      ]}
                    >
                      <Image source={{ uri: imageUrl }} style={styles.image} />
                    </Pressable>
                  ))}
                </View>
                {errors[`choices.${index}.imageUrl`] ? (
                  <Text style={styles.error}>
                    {errors[`choices.${index}.imageUrl`]}
                  </Text>
                ) : null}
                <ListingOptionChip
                  label={`Remove choice ${index + 1}`}
                  onPress={() =>
                    onChange({
                      ...value,
                      choices: value.choices.filter((_, i) => i !== index),
                    })
                  }
                />
              </View>
            ))}
            <SellerField
              label="Add a choice"
              placeholder="Vanilla"
              value={choiceInput}
              onChangeText={setChoiceInput}
            />
            <ActionButton
              label="Add choice"
              variant="secondary"
              disabled={
                !choiceInput.trim() ||
                value.choices.some(
                  (choice) => choice.label === choiceInput.trim()
                )
              }
              onPress={() => {
                onChange({
                  ...value,
                  choices: [...value.choices, { label: choiceInput.trim() }],
                });
                setChoiceInput("");
              }}
            />
          </View>
        )}
        {errors.choices ? (
          <Text style={styles.error}>{errors.choices}</Text>
        ) : null}
      </SellerCard>
    </>
  );
}
export const listingOptionStyles = StyleSheet.create({
  section: { gap: 14 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  note: { color: theme.mutedText, fontSize: 14, lineHeight: 21 },
  error: { color: theme.danger, fontSize: 14, lineHeight: 20 },
  chip: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
    justifyContent: "center",
  },
  selected: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { fontSize: 14, color: theme.text, fontWeight: "600" },
  selectedText: { color: theme.surface },
  disabled: { opacity: 0.5 },
  optionRow: { gap: 10, marginTop: 16 },
  grow: { flex: 1 },
  choice: {
    gap: 12,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  image: { width: 64, height: 64, borderRadius: 6 },
  photoButton: {
    padding: 3,
    borderWidth: 2,
    borderColor: "transparent",
    borderRadius: 10,
  },
  photoSelected: { borderColor: theme.primary },
});
const styles = listingOptionStyles;
