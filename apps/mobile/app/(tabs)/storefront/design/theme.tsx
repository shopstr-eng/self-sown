import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { StorefrontColorScheme } from "@self-sown/domain";

import {
  ColorField,
  DesignHint,
  DesignSectionTitle,
  DesignTextField,
  OptionChips,
  ToggleRow,
} from "@/components/design-controls";
import { DesignScreen } from "@/components/design-screen";
import { ActionButton, SellerCard } from "@/components/seller-ui";
import { useSellerListings } from "@/hooks/use-seller-bootstrap";
import { useStorefrontDesignStore } from "@/lib/storefront-design-store";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

// Keep in sync with GOOGLE_FONT_OPTIONS in components/settings/
// shop-profile-form.tsx — the web renders these via Google Fonts, so a name
// picked here must exist in that list to look the same on the live stall.
const FONT_OPTIONS = [
  "Inter",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Poppins",
  "Playfair Display",
  "Merriweather",
  "Raleway",
  "Nunito",
  "Oswald",
  "Source Sans 3",
  "PT Serif",
  "Bitter",
  "Crimson Text",
];

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const COLOR_KEYS: { key: keyof StorefrontColorScheme; label: string }[] = [
  { key: "primary", label: "Primary (buttons, highlights)" },
  { key: "secondary", label: "Secondary" },
  { key: "accent", label: "Accent" },
  { key: "background", label: "Page background" },
  { key: "text", label: "Body text" },
];

// The config stores the palette as one all-or-nothing object (the parser
// drops partial schemes), so the screen edits the five colors locally and
// writes them as a set.
function PaletteEditor() {
  const draft = useStorefrontDesignStore((state) => state.draft);
  const update = useStorefrontDesignStore((state) => state.update);
  const [colors, setColors] = useState<
    Record<keyof StorefrontColorScheme, string>
  >({
    primary: "",
    secondary: "",
    accent: "",
    background: "",
    text: "",
  });

  useEffect(() => {
    if (draft.colorScheme) {
      setColors({ ...draft.colorScheme });
    }
    // Only seed when a saved scheme first arrives — not on every draft bump,
    // or local typing would be overwritten by the store echo.
  }, [draft.colorScheme === undefined]);

  const complete = COLOR_KEYS.every(({ key }) => HEX_RE.test(colors[key]));
  const dirtyAgainstDraft =
    JSON.stringify(draft.colorScheme ?? null) !==
    JSON.stringify(complete ? colors : null);

  return (
    <SellerCard>
      <DesignSectionTitle
        title="Color palette"
        description="Five colors paint your whole storefront. Set all five — a partial palette can't be saved."
      />
      {COLOR_KEYS.map(({ key, label }) => (
        <ColorField
          key={key}
          label={label}
          value={colors[key] || undefined}
          onChange={(value) =>
            setColors((current) => ({ ...current, [key]: value ?? "" }))
          }
        />
      ))}
      <View style={styles.paletteActions}>
        <ActionButton
          label="Apply palette"
          disabled={!complete || !dirtyAgainstDraft}
          onPress={() =>
            update((current) => ({
              ...current,
              colorScheme: { ...colors },
            }))
          }
        />
        {draft.colorScheme ? (
          <ActionButton
            label="Reset to theme default"
            variant="secondary"
            onPress={() => {
              setColors({
                primary: "",
                secondary: "",
                accent: "",
                background: "",
                text: "",
              });
              update((current) => {
                const next = { ...current };
                delete next.colorScheme;
                return next;
              });
            }}
          />
        ) : null}
      </View>
      {!draft.colorScheme && !complete ? (
        <DesignHint text="No custom palette set — your stall uses the default theme." />
      ) : null}
    </SellerCard>
  );
}

export default function ThemeEditorScreen() {
  const draft = useStorefrontDesignStore((state) => state.draft);
  const update = useStorefrontDesignStore((state) => state.update);
  const session = useSessionStore((state) => state.session);
  const listingsQuery = useSellerListings(session?.pubkey);

  return (
    <DesignScreen
      title="Theme & colors"
      description="Palette, fonts, and the overall shape of your storefront."
    >
      <PaletteEditor />

      <SellerCard>
        <DesignSectionTitle title="Fonts" />
        <OptionChips
          label="Heading font"
          value={draft.fontHeading}
          options={FONT_OPTIONS.map((font) => ({ value: font, label: font }))}
          onChange={(value) =>
            update((current) => ({ ...current, fontHeading: value }))
          }
        />
        <OptionChips
          label="Body font"
          value={draft.fontBody}
          options={FONT_OPTIONS.map((font) => ({ value: font, label: font }))}
          onChange={(value) =>
            update((current) => ({ ...current, fontBody: value }))
          }
        />
        <DesignSectionTitle
          title="Custom fonts"
          description="Load a self-hosted font instead of a preset."
        />
        <DesignTextField
          label="Heading font file URL"
          value={draft.customFontHeadingUrl}
          onChange={(value) =>
            update((current) => ({ ...current, customFontHeadingUrl: value }))
          }
          placeholder="https://…/font.woff2"
          keyboardType="url"
        />
        <DesignTextField
          label="Heading font family name"
          value={draft.customFontHeadingName}
          onChange={(value) =>
            update((current) => ({ ...current, customFontHeadingName: value }))
          }
          placeholder="My Custom Font"
        />
        <DesignTextField
          label="Body font file URL"
          value={draft.customFontBodyUrl}
          onChange={(value) =>
            update((current) => ({ ...current, customFontBodyUrl: value }))
          }
          placeholder="https://…/font.woff2"
          keyboardType="url"
        />
        <DesignTextField
          label="Body font family name"
          value={draft.customFontBodyName}
          onChange={(value) =>
            update((current) => ({ ...current, customFontBodyName: value }))
          }
          placeholder="My Custom Font"
        />
      </SellerCard>

      <SellerCard>
        <DesignSectionTitle title="Layout" />
        <OptionChips
          label="Landing page style"
          value={draft.landingPageStyle}
          options={[
            { value: "classic", label: "Classic" },
            { value: "hero", label: "Hero" },
            { value: "minimal", label: "Minimal" },
          ]}
          onChange={(value) =>
            update((current) => ({ ...current, landingPageStyle: value }))
          }
        />
        <OptionChips
          label="Product listing layout"
          value={draft.productLayout}
          options={[
            { value: "grid", label: "Grid" },
            { value: "list", label: "List" },
            { value: "featured", label: "Featured" },
          ]}
          onChange={(value) =>
            update((current) => ({ ...current, productLayout: value }))
          }
        />
        <ToggleRow
          label="Raised card shadows"
          description="Give storefront cards the bold offset-shadow look."
          value={draft.neoShadows === true}
          onChange={(value) =>
            update((current) => ({
              ...current,
              neoShadows: value ? true : undefined,
            }))
          }
        />
      </SellerCard>

      <SellerCard>
        <DesignSectionTitle
          title="Landing page mode"
          description="Optionally serve a single product as your storefront's front page."
        />
        <OptionChips
          label="Front page"
          value={draft.landingPageMode}
          allowUnset={false}
          options={[
            { value: "default", label: "My designed landing page" },
            { value: "product", label: "A single product" },
          ]}
          onChange={(value) =>
            update((current) => ({
              ...current,
              landingPageMode: value === "default" ? undefined : value,
            }))
          }
        />
        {draft.landingPageMode === "product" ? (
          <OptionChips
            label="Product to feature"
            value={draft.landingProductDTag}
            options={(listingsQuery.data ?? []).map((listing) => ({
              value: listing.dTag ?? listing.id,
              label: listing.title,
            }))}
            onChange={(value) =>
              update((current) => ({ ...current, landingProductDTag: value }))
            }
          />
        ) : null}
        {draft.customDomain ? (
          <Text style={styles.domainNote}>
            Custom domain ({draft.customDomain}) is managed in web settings.
          </Text>
        ) : null}
      </SellerCard>
    </DesignScreen>
  );
}

const styles = StyleSheet.create({
  paletteActions: { gap: 8, marginTop: 4 },
  domainNote: {
    color: sellerThemeTokens.mutedText,
    fontSize: 12,
    fontFamily: sellerFonts.regular,
    marginTop: 4,
  },
});
