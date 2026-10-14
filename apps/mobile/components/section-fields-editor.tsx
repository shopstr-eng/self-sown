import { StyleSheet, Text, View } from "react-native";

import {
  resolveSectionElements,
  type StorefrontSection,
  type StorefrontSectionElement,
} from "@self-sown/domain";

import {
  ColorField,
  DesignHint,
  DesignSectionTitle,
  DesignTextField,
  ListItemChrome,
  NumberField,
  OptionChips,
  ToggleRow,
  AddItemButton,
} from "@/components/design-controls";
import { SellerCard } from "@/components/seller-ui";
import { useSellerListings } from "@/hooks/use-seller-bootstrap";
import {
  SECTION_FIELD_SPECS,
  type FieldSpec,
  type ItemFieldSpec,
} from "@/lib/section-field-specs";
import { moveItem } from "@/lib/storefront-design-scopes";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

// Spec-driven section field editor shared by BOTH design surfaces: the shop
// design screens (storefront store, scope-addressed sections) and the
// per-product page design editor (the listing's page_config tag). One
// renderer means a new section field shows up in both places at once.

type SectionRecord = Record<string, unknown>;

function readValue(section: StorefrontSection, key: string): unknown {
  return (section as unknown as SectionRecord)[key];
}

export function writeValue(
  section: StorefrontSection,
  key: string,
  value: unknown
): StorefrontSection {
  const next: SectionRecord = { ...(section as unknown as SectionRecord) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as unknown as StorefrontSection;
}

function RecordListFields({
  section,
  spec,
  onPatch,
}: {
  section: StorefrontSection;
  spec: Extract<FieldSpec, { kind: "records" }>;
  onPatch: (key: string, value: unknown) => void;
}) {
  const items =
    (readValue(section, spec.key) as SectionRecord[] | undefined) ?? [];

  const patchItem = (index: number, key: string, value: unknown) => {
    const next = items.map((item, i) => {
      if (i !== index) return item;
      const updated = { ...item };
      if (value === undefined || value === "") delete updated[key];
      else updated[key] = value;
      return updated;
    });
    onPatch(spec.key, next);
  };

  return (
    <View style={styles.groupWrap}>
      <DesignSectionTitle title={spec.label} />
      {items.map((item, index) => (
        <ListItemChrome
          key={index}
          title={
            String(item[spec.titleKey] ?? "").trim() ||
            `${spec.label.replace(/s$/, "")} ${index + 1}`
          }
          isFirst={index === 0}
          isLast={index === items.length - 1}
          onMoveUp={() => onPatch(spec.key, moveItem(items, index, -1))}
          onMoveDown={() => onPatch(spec.key, moveItem(items, index, 1))}
          onDelete={() =>
            onPatch(
              spec.key,
              items.filter((_entry, i) => i !== index)
            )
          }
        >
          {spec.fields.map((field) => (
            <ItemField
              key={field.key}
              field={field}
              value={item[field.key]}
              onChange={(value) => patchItem(index, field.key, value)}
            />
          ))}
        </ListItemChrome>
      ))}
      <AddItemButton
        label={spec.addLabel}
        onPress={() => onPatch(spec.key, [...items, spec.makeNew()])}
      />
    </View>
  );
}

function ItemField({
  field,
  value,
  onChange,
}: {
  field: ItemFieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  // comparisonColumns carry values: string[] — edit as newline-separated text.
  const textValue = Array.isArray(value)
    ? value.map(String).join("\n")
    : typeof value === "string"
      ? value
      : typeof value === "number"
        ? String(value)
        : "";

  if (field.kind === "chips") {
    return (
      <OptionChips
        label={field.label}
        value={typeof value === "string" ? value : undefined}
        options={field.options ?? []}
        onChange={onChange}
      />
    );
  }
  if (field.kind === "number") {
    return (
      <NumberField
        label={field.label}
        value={typeof value === "number" ? value : undefined}
        min={field.min}
        max={field.max}
        onChange={onChange}
      />
    );
  }
  return (
    <DesignTextField
      label={field.label}
      value={textValue}
      placeholder={field.placeholder}
      multiline={field.kind === "textarea"}
      keyboardType={field.kind === "url" ? "url" : "default"}
      onChange={(next) => {
        if (
          Array.isArray(value) ||
          (field.kind === "textarea" && next?.includes("\n"))
        ) {
          if (Array.isArray(value)) {
            onChange(
              (next ?? "")
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
            );
            return;
          }
        }
        onChange(next);
      }}
    />
  );
}

function ElementOrderEditor({
  section,
  onPatch,
}: {
  section: StorefrontSection;
  onPatch: (key: string, value: unknown) => void;
}) {
  const order = resolveSectionElements(section);
  if (order.length === 0) return null;
  return (
    <View style={styles.groupWrap}>
      <DesignSectionTitle
        title="Element order"
        description="Arrange where the heading, image, buttons, and content sit inside this section."
      />
      {order.map((element, index) => (
        <ListItemChrome
          key={element}
          title={ELEMENT_LABELS[element] ?? element}
          isFirst={index === 0}
          isLast={index === order.length - 1}
          onMoveUp={() => onPatch("elementOrder", moveItem(order, index, -1))}
          onMoveDown={() => onPatch("elementOrder", moveItem(order, index, 1))}
        />
      ))}
    </View>
  );
}

const ELEMENT_LABELS: Record<StorefrontSectionElement, string> = {
  heading: "Heading",
  subheading: "Subheading",
  body: "Body text",
  image: "Image",
  buttons: "Buttons",
  content: "Main content",
};

function ProductIdsPicker({
  section,
  onPatch,
}: {
  section: StorefrontSection;
  onPatch: (key: string, value: unknown) => void;
}) {
  const session = useSessionStore((state) => state.session);
  const listingsQuery = useSellerListings(session?.pubkey);
  const selected =
    (readValue(section, "productIds") as string[] | undefined) ?? [];
  const listings = listingsQuery.data ?? [];

  return (
    <View style={styles.groupWrap}>
      <DesignSectionTitle
        title="Curated products"
        description="Pick specific products for this section. With none picked, your listings are shown automatically."
      />
      {listings.length === 0 ? (
        <DesignHint text="No listings loaded — pull to refresh the Listings tab, then return." />
      ) : (
        listings.map((listing) => {
          const checked = selected.includes(listing.id);
          return (
            <ToggleRow
              key={listing.id}
              label={listing.title}
              value={checked}
              onChange={(value) =>
                onPatch(
                  "productIds",
                  value
                    ? [...selected, listing.id]
                    : selected.filter((id) => id !== listing.id)
                )
              }
            />
          );
        })
      )}
    </View>
  );
}

function HeroProductPicker({
  section,
  onPatch,
}: {
  section: StorefrontSection;
  onPatch: (key: string, value: unknown) => void;
}) {
  const session = useSessionStore((state) => state.session);
  const listingsQuery = useSellerListings(session?.pubkey);
  const selected = readValue(section, "heroProductId") as string | undefined;
  const listings = listingsQuery.data ?? [];

  return (
    <View style={styles.groupWrap}>
      <DesignSectionTitle
        title="Featured product"
        description="Pin one product inside this section."
      />
      <OptionChips
        label="Product"
        value={selected}
        options={listings.map((listing) => ({
          value: listing.id,
          label: listing.title,
        }))}
        onChange={(value) => onPatch("heroProductId", value)}
      />
    </View>
  );
}

function SpecField({
  section,
  spec,
  onPatch,
}: {
  section: StorefrontSection;
  spec: FieldSpec;
  onPatch: (key: string, value: unknown) => void;
}) {
  switch (spec.kind) {
    case "text":
    case "textarea":
    case "url":
    case "email":
      return (
        <DesignTextField
          label={spec.label}
          value={readValue(section, spec.key) as string | undefined}
          placeholder={spec.placeholder}
          hint={spec.hint}
          multiline={spec.kind === "textarea"}
          keyboardType={
            spec.kind === "url"
              ? "url"
              : spec.kind === "email"
                ? "email-address"
                : "default"
          }
          onChange={(value) => onPatch(spec.key, value)}
        />
      );
    case "color":
      return (
        <ColorField
          label={spec.label}
          value={readValue(section, spec.key) as string | undefined}
          onChange={(value) => onPatch(spec.key, value)}
        />
      );
    case "number":
      return (
        <NumberField
          label={spec.label}
          value={
            spec.fromStore
              ? spec.fromStore(readValue(section, spec.key))
              : (readValue(section, spec.key) as number | undefined)
          }
          min={spec.min}
          max={spec.max}
          description={spec.hint}
          onChange={(value) =>
            onPatch(
              spec.key,
              value !== undefined && spec.toStore ? spec.toStore(value) : value
            )
          }
        />
      );
    case "toggle":
      return (
        <ToggleRow
          label={spec.label}
          description={spec.description}
          value={readValue(section, spec.key) === true}
          onChange={(value) => onPatch(spec.key, value ? true : undefined)}
        />
      );
    case "chips":
      return (
        <OptionChips
          label={spec.label}
          value={
            spec.fromStore
              ? spec.fromStore(readValue(section, spec.key))
              : (readValue(section, spec.key) as string | undefined)
          }
          options={spec.options}
          allowUnset={spec.allowUnset !== false}
          onChange={(value) =>
            onPatch(spec.key, spec.toStore ? spec.toStore(value) : value)
          }
        />
      );
    case "records":
      return (
        <RecordListFields section={section} spec={spec} onPatch={onPatch} />
      );
    case "strings": {
      const values =
        (readValue(section, spec.key) as string[] | undefined) ?? [];
      return (
        <DesignTextField
          label={spec.label}
          value={values.join("\n")}
          hint={spec.hint}
          multiline
          onChange={(value) =>
            onPatch(
              spec.key,
              value === undefined
                ? undefined
                : value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
            )
          }
        />
      );
    }
    case "elementOrder":
      return <ElementOrderEditor section={section} onPatch={onPatch} />;
    case "productIds":
      return <ProductIdsPicker section={section} onPatch={onPatch} />;
    case "heroProduct":
      return <HeroProductPicker section={section} onPatch={onPatch} />;
    default:
      return null;
  }
}

export function SectionFieldsEditor({
  section,
  onPatch,
}: {
  section: StorefrontSection;
  onPatch: (key: string, value: unknown) => void;
}) {
  const specs = SECTION_FIELD_SPECS[section.type] ?? [];
  return (
    <>
      <SellerCard>
        <ToggleRow
          label="Show this section"
          value={section.enabled !== false}
          onChange={(value) => onPatch("enabled", value)}
        />
      </SellerCard>
      <SellerCard>
        {specs.length === 0 ? (
          <Text style={styles.noFields}>
            This section has no editable fields on mobile yet — its web settings
            are preserved as-is when you save.
          </Text>
        ) : (
          specs.map((spec, index) => (
            <SpecField
              key={`${spec.kind}-${"key" in spec ? spec.key : index}`}
              section={section}
              spec={spec}
              onPatch={onPatch}
            />
          ))
        )}
      </SellerCard>
    </>
  );
}

const styles = StyleSheet.create({
  groupWrap: { marginBottom: 14, gap: 6 },
  noFields: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    fontFamily: sellerFonts.regular,
    lineHeight: 18,
  },
});
