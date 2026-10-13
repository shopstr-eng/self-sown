import { useLocalSearchParams, type Href } from "expo-router";

import type { StorefrontColorScheme } from "@self-sown/domain";

import {
  ColorField,
  DesignHint,
  DesignSectionTitle,
  DesignTextField,
  ToggleRow,
} from "@/components/design-controls";
import { ProductDesignScreen } from "@/components/product-design-screen";
import { SectionListEditor } from "@/components/section-list-editor";
import { SellerCard } from "@/components/seller-ui";
import { useProductPageDesignStore } from "@/lib/product-page-design-store";
import { PRODUCT_PAGE_SECTION_TYPES } from "@/lib/section-field-specs";

// Per-product page design — the mobile counterpart of the web's "Customize
// Product Page" modal. Everything here serializes into the page_config tag
// on the listing event via the shared domain builder, so a product designed
// on web renders identically when edited on mobile and vice versa.

const THEME_OVERRIDE_FIELDS: {
  key: keyof StorefrontColorScheme;
  label: string;
}[] = [
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "accent", label: "Accent" },
  { key: "background", label: "Background" },
  { key: "text", label: "Text" },
];

export default function ListingPageDesignScreen() {
  const { listingId } = useLocalSearchParams<{ listingId?: string }>();
  const draft = useProductPageDesignStore((state) => state.draft);
  const update = useProductPageDesignStore((state) => state.update);

  if (!listingId) return null;

  return (
    <ProductDesignScreen
      listingId={listingId}
      title="Page design"
      description="Override this one product's page: sections, colors, and how it appears in search and link previews. With shop defaults on, it uses your standard product page."
    >
      <SellerCard>
        <ToggleRow
          label="Use shop product page defaults"
          description="Off = this product gets its own section list below."
          value={draft.useShopDefaults}
          onChange={(value) =>
            update((current) => ({ ...current, useShopDefaults: value }))
          }
        />
      </SellerCard>
      {draft.useShopDefaults ? (
        <SellerCard>
          <DesignHint text="This product uses your shop-wide product page template. Turn defaults off to give it its own sections." />
        </SellerCard>
      ) : (
        <SellerCard>
          <DesignSectionTitle
            title="Sections"
            description="This product's own page sections, top to bottom."
          />
          <SectionListEditor
            scope="productDefaults"
            allowedTypes={PRODUCT_PAGE_SECTION_TYPES}
            sections={draft.sections}
            onWrite={(next) =>
              update((current) => ({ ...current, sections: next }))
            }
            editRoute={(sectionId) =>
              `/listings/design/section/${sectionId}?listingId=${listingId}` as Href
            }
          />
        </SellerCard>
      )}
      <SellerCard>
        <DesignSectionTitle
          title="Theme overrides"
          description="Recolor just this product's page. Cleared fields inherit your shop theme."
        />
        {THEME_OVERRIDE_FIELDS.map(({ key, label }) => (
          <ColorField
            key={key}
            label={label}
            value={draft.themeOverrides[key]}
            allowEmpty
            onChange={(value) =>
              update((current) => {
                const themeOverrides = { ...current.themeOverrides };
                if (value) themeOverrides[key] = value;
                else delete themeOverrides[key];
                return { ...current, themeOverrides };
              })
            }
          />
        ))}
      </SellerCard>
      <SellerCard>
        <DesignSectionTitle
          title="Search & social"
          description="How this product's own page appears in search results and link previews."
        />
        <DesignTextField
          label="Meta title"
          value={draft.metaTitle}
          hint="200 characters max."
          onChange={(value) =>
            update((current) => ({ ...current, metaTitle: value ?? "" }))
          }
        />
        <DesignTextField
          label="Meta description"
          value={draft.metaDescription}
          multiline
          hint="500 characters max."
          onChange={(value) =>
            update((current) => ({ ...current, metaDescription: value ?? "" }))
          }
        />
        <DesignTextField
          label="Social image URL"
          value={draft.ogImage}
          keyboardType="url"
          placeholder="https://…"
          onChange={(value) =>
            update((current) => ({ ...current, ogImage: value ?? "" }))
          }
        />
      </SellerCard>
    </ProductDesignScreen>
  );
}
