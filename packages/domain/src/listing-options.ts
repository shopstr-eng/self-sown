import type { ProductFormValues } from "./forms";
import {
  isSellerDecimal,
  isSellerQuantity,
  sellerPriceDecimals,
} from "./listing-option-values";

export type ListingSizeDraft = { label: string; quantity: string };
export type ListingPriceOptionDraft = { label: string; price: string };
export type ListingChoiceDraft = { label: string; imageUrl?: string };
export type ListingBundleTierDraft = {
  units: string;
  totalPrice: string;
  optionLabel?: string;
};
export type SellerListingOptionsDraft = {
  sizes: ListingSizeDraft[];
  volumes: ListingPriceOptionDraft[];
  weights: ListingPriceOptionDraft[];
  choiceLabel: string;
  choices: ListingChoiceDraft[];
  choiceDisplay: "buttons" | "dropdown";
  bundleMode: "disabled" | "common" | "per-option";
  bundles: ListingBundleTierDraft[];
};
export type ListingOptionGroup =
  | "sizes"
  | "volumes"
  | "weights"
  | "choices"
  | "bundles";
export type ListingOptionsIssue = {
  group: ListingOptionGroup;
  message: string;
};
export type ListingOptionsErrors = Record<string, string>;
const LISTING_OPTION_TAGS: Record<ListingOptionGroup, string[]> = {
  sizes: ["size"],
  volumes: ["volume"],
  weights: ["weight"],
  choices: ["variant", "variant_label", "variant_display"],
  bundles: ["bulk"],
};
export function isListingOptionTag(key: string): boolean {
  return Object.values(LISTING_OPTION_TAGS).some((keys) => keys.includes(key));
}
export function createEmptySellerListingOptions(): SellerListingOptionsDraft {
  return {
    sizes: [],
    volumes: [],
    weights: [],
    choiceLabel: "",
    choices: [],
    choiceDisplay: "buttons",
    bundleMode: "disabled",
    bundles: [],
  };
}
function listingOptionGroupValue(
  value: SellerListingOptionsDraft,
  group: ListingOptionGroup
): unknown {
  if (group === "choices")
    return [value.choiceLabel, value.choiceDisplay, value.choices];
  if (group === "bundles") return [value.bundleMode, value.bundles];
  return value[group];
}
function listingOptionGroupChanged(
  value: SellerListingOptionsDraft,
  source: SellerListingOptionsDraft,
  group: ListingOptionGroup
): boolean {
  return (
    JSON.stringify(listingOptionGroupValue(value, group)) !==
    JSON.stringify(listingOptionGroupValue(source, group))
  );
}
export function validateSellerListingOptions(
  value: SellerListingOptionsDraft,
  currency: string
): ListingOptionsErrors {
  const errors: ListingOptionsErrors = {};
  const decimals = sellerPriceDecimals(currency);
  for (const group of ["sizes", "volumes", "weights", "choices"] as const) {
    const seen = new Set<string>();
    value[group].forEach((row, index) => {
      const key = `${group}.${index}`;
      const label = row.label.trim();
      if (!label || seen.has(label))
        errors[`${key}.label`] = "Use a unique, nonempty option name.";
      seen.add(label);
      if ("quantity" in row && !isSellerQuantity(row.quantity))
        errors[`${key}.quantity`] =
          "Enter a whole quantity from 0 to 2147483647.";
      if ("price" in row && !isSellerDecimal(row.price, decimals))
        errors[`${key}.price`] =
          `Enter a nonnegative price with at most ${decimals} decimal places.`;
      if (
        "imageUrl" in row &&
        row.imageUrl &&
        !/^https?:\/\/[^\s]+$/i.test(row.imageUrl)
      )
        errors[`${key}.imageUrl`] = "Choose an uploaded product image.";
    });
  }
  const labels = [...value.volumes, ...value.weights].map((row) =>
    row.label.trim()
  );
  if (value.bundleMode !== "disabled") {
    if (!value.bundles.length)
      errors.bundles = "Add a bundle or turn bundle pricing off.";
    const seen = new Set<string>();
    value.bundles.forEach((tier, index) => {
      const key = `bundles.${index}`;
      const scope =
        value.bundleMode === "common" ? "" : (tier.optionLabel ?? "").trim();
      if (
        value.bundleMode === "per-option" &&
        labels.filter((label) => label === scope).length !== 1
      )
        errors[`${key}.optionLabel`] =
          "Choose a uniquely named volume or weight.";
      const identity = JSON.stringify([scope, Number(tier.units)]);
      if (
        !isSellerQuantity(tier.units) ||
        Number(tier.units) < 1 ||
        seen.has(identity)
      )
        errors[`${key}.units`] =
          "Enter a unique positive whole unit count for this option.";
      seen.add(identity);
      // The website stores bundle totals directly; never silently round imported totals.
      if (!isSellerDecimal(tier.totalPrice) || Number(tier.totalPrice) <= 0)
        errors[`${key}.totalPrice`] = "Enter a positive total bundle price.";
      if (value.bundleMode === "common" && tier.optionLabel)
        errors[`${key}.optionLabel`] =
          "Common bundles cannot reference an individual option.";
    });
  }
  return errors;
}
export function parseSellerListingOptions(tags: string[][]): {
  draft: SellerListingOptionsDraft;
  issues: ListingOptionsIssue[];
} {
  const draft = createEmptySellerListingOptions();
  const issues: ListingOptionsIssue[] = [];
  const flag = (group: ListingOptionGroup) => {
    if (!issues.some((issue) => issue.group === group))
      issues.push({
        group,
        message:
          "These options need to be corrected on the website before they can be edited here.",
      });
  };
  const single = new Set<string>();
  for (const tag of tags) {
    const [key, label = "", value = ""] = tag;
    if (key === "size") {
      draft.sizes.push({ label, quantity: value });
      if (tag.length !== 3) flag("sizes");
    }
    if (key === "volume" || key === "weight") {
      const group = key === "volume" ? "volumes" : "weights";
      draft[group].push({ label, price: value });
      if (tag.length !== 3) flag(group);
    }
    if (key === "variant") {
      draft.choices.push({ label, ...(value ? { imageUrl: value } : {}) });
      if (tag.length < 2 || tag.length > 3) flag("choices");
    }
    if (key === "variant_label" || key === "variant_display") {
      if (single.has(key) || tag.length !== 2) flag("choices");
      single.add(key);
      if (key === "variant_label") draft.choiceLabel = label;
      else if (label === "buttons" || label === "dropdown")
        draft.choiceDisplay = label;
      else flag("choices");
    }
    if (key === "bulk") {
      draft.bundles.push({
        units: label,
        totalPrice: value,
        ...(tag[3] ? { optionLabel: tag[3] } : {}),
      });
      if (tag.length < 3 || tag.length > 4) flag("bundles");
    }
  }
  if (draft.bundles.length)
    draft.bundleMode = draft.bundles.some((tier) => tier.optionLabel)
      ? "per-option"
      : "common";
  // Maximum website precision identifies malformed imports without rejecting BTC values.
  for (const key of Object.keys(validateSellerListingOptions(draft, "BTC")))
    flag(key.split(".")[0] as ListingOptionGroup);
  if (
    !draft.choices.length &&
    (draft.choiceLabel || single.has("variant_display"))
  )
    flag("choices");
  return { draft, issues };
}
export function validateSellerListingOptionChanges(
  options: SellerListingOptionsDraft,
  currency: string,
  sourceTags: string[][] = []
): ListingOptionsErrors {
  const source = parseSellerListingOptions(sourceTags);
  const errors = validateSellerListingOptions(options, currency);
  for (const group of Object.keys(
    LISTING_OPTION_TAGS
  ) as ListingOptionGroup[]) {
    const changed = listingOptionGroupChanged(options, source.draft, group);
    // An option removal also changes whether a preserved per-option tier is valid.
    const dependencyChanged =
      group === "bundles" &&
      (listingOptionGroupChanged(options, source.draft, "volumes") ||
        listingOptionGroupChanged(options, source.draft, "weights"));
    const sourceCurrency = sourceTags.find((tag) => tag[0] === "price")?.[2];
    const currencyChanged =
      (group === "volumes" || group === "weights") &&
      sourceCurrency &&
      sourceCurrency.toUpperCase() !== currency.trim().toUpperCase();
    if (!changed && !dependencyChanged && !currencyChanged) {
      for (const key of Object.keys(errors))
        if (key === group || key.startsWith(`${group}.`)) delete errors[key];
    } else if (source.issues.some((issue) => issue.group === group)) {
      errors[group] =
        "Edit these existing options on the website to avoid losing data.";
    }
  }
  return errors;
}
export function buildSellerListingOptionTags(
  options: SellerListingOptionsDraft,
  sourceTags: string[][] = []
): ProductFormValues {
  const source = parseSellerListingOptions(sourceTags);
  const generated: Record<ListingOptionGroup, ProductFormValues> = {
    sizes: options.sizes.map((row) => [
      "size",
      row.label.trim(),
      row.quantity.trim(),
    ]),
    volumes: options.volumes.map((row) => [
      "volume",
      row.label.trim(),
      row.price.trim(),
    ]),
    weights: options.weights.map((row) => [
      "weight",
      row.label.trim(),
      row.price.trim(),
    ]),
    choices: options.choices.length
      ? [
          ...(options.choiceLabel.trim()
            ? [
                ["variant_label", options.choiceLabel.trim()] as [
                  string,
                  ...string[],
                ],
              ]
            : []),
          ...options.choices.map((row): [string, ...string[]] => [
            "variant",
            row.label.trim(),
            ...(row.imageUrl ? [row.imageUrl] : []),
          ]),
          ["variant_display", options.choiceDisplay],
        ]
      : [],
    bundles:
      options.bundleMode === "disabled"
        ? []
        : options.bundles.map((tier) => [
            "bulk",
            tier.units.trim(),
            tier.totalPrice.trim(),
            ...(options.bundleMode === "per-option"
              ? [tier.optionLabel!.trim()]
              : []),
          ]),
  };
  return (Object.keys(LISTING_OPTION_TAGS) as ListingOptionGroup[]).flatMap(
    (group) => {
      if (!listingOptionGroupChanged(options, source.draft, group))
        return sourceTags
          .filter((tag) => LISTING_OPTION_TAGS[group].includes(tag[0]!))
          .map((tag) => [tag[0]!, ...tag.slice(1)] as [string, ...string[]]);
      if (source.issues.some((issue) => issue.group === group))
        throw new Error("These product options must be edited on the website.");
      return generated[group];
    }
  );
}
