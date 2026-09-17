import { Alert, Text, View } from "react-native";
import { ActionButton, SellerCard, SellerField } from "@/components/seller-ui";
import {
  ListingOptionChip,
  listingOptionStyles as styles,
  type ListingOptionsEditorProps,
} from "./listing-options-editor";
import { changeListingBundleMode } from "@/lib/listing-editor-state";

type Props = Pick<
  ListingOptionsEditorProps,
  "value" | "errors" | "issues" | "disabled" | "onChange" | "currency"
>;
export function ListingBundleEditor({
  value,
  errors,
  issues,
  disabled,
  onChange,
  currency,
}: Props) {
  const issue = issues.find((issue) => issue.group === "bundles");
  const optionLabels = [
    ...new Set([...value.volumes, ...value.weights].map((row) => row.label)),
  ];
  const update = (
    index: number,
    patch: Partial<(typeof value.bundles)[number]>
  ) =>
    onChange({
      ...value,
      bundles: value.bundles.map((tier, i) =>
        i === index ? { ...tier, ...patch } : tier
      ),
    });
  return (
    <SellerCard
      title="Bundle pricing"
      description="Set a total price for a bundle of units. For example, 3 units for 24 USD."
    >
      {issue ? (
        <Text style={styles.note}>{issue.message}</Text>
      ) : (
        <View pointerEvents={disabled ? "none" : "auto"} style={styles.section}>
          <View style={styles.wrap}>
            {(
              [
                ["disabled", "Off"],
                ["common", "Same for all options"],
                ["per-option", "By volume or weight"],
              ] as const
            ).map(([mode, label]) => (
              <ListingOptionChip
                key={mode}
                label={label}
                selected={value.bundleMode === mode}
                disabled={mode === "per-option" && !optionLabels.length}
                onPress={() => {
                  if (mode === value.bundleMode) return;
                  const apply = () =>
                    onChange(changeListingBundleMode(value, mode));
                  if (value.bundles.length)
                    Alert.alert(
                      "Replace bundle prices?",
                      "Changing this setting removes the current bundle prices.",
                      [
                        { text: "Keep prices", style: "cancel" },
                        {
                          text: "Replace",
                          style: "destructive",
                          onPress: apply,
                        },
                      ]
                    );
                  else apply();
                }}
              />
            ))}
          </View>
          {value.bundleMode !== "disabled" && (
            <>
              {value.bundles.map((tier, index) => (
                <View key={index} style={styles.choice}>
                  <Text style={styles.note}>Bundle {index + 1}</Text>
                  {value.bundleMode === "per-option" && (
                    <View style={styles.wrap}>
                      {optionLabels.map((label) => (
                        <ListingOptionChip
                          key={label}
                          label={label}
                          selected={tier.optionLabel === label}
                          onPress={() => update(index, { optionLabel: label })}
                        />
                      ))}
                    </View>
                  )}
                  {errors[`bundles.${index}.optionLabel`] ? (
                    <Text style={styles.error}>
                      {errors[`bundles.${index}.optionLabel`]}
                    </Text>
                  ) : null}
                  <SellerField
                    label="Units"
                    value={tier.units}
                    keyboardType="number-pad"
                    error={errors[`bundles.${index}.units`]}
                    onChangeText={(units) => update(index, { units })}
                  />
                  <SellerField
                    label={`Total price (${currency})`}
                    value={tier.totalPrice}
                    keyboardType="decimal-pad"
                    error={errors[`bundles.${index}.totalPrice`]}
                    onChangeText={(totalPrice) => update(index, { totalPrice })}
                  />
                  <ListingOptionChip
                    label={`Remove bundle ${index + 1}`}
                    onPress={() =>
                      onChange({
                        ...value,
                        bundles: value.bundles.filter((_, i) => i !== index),
                      })
                    }
                  />
                </View>
              ))}
              <ActionButton
                label="Add bundle"
                variant="secondary"
                onPress={() =>
                  onChange({
                    ...value,
                    bundles: [
                      ...value.bundles,
                      {
                        units: "",
                        totalPrice: "",
                        ...(value.bundleMode === "per-option"
                          ? { optionLabel: optionLabels[0] }
                          : {}),
                      },
                    ],
                  })
                }
              />
            </>
          )}
        </View>
      )}
      {errors.bundles ? (
        <Text style={styles.error}>{errors.bundles}</Text>
      ) : null}
    </SellerCard>
  );
}
