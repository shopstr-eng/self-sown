import {
  DesignSectionTitle,
  DesignTextField,
  ToggleRow,
} from "@/components/design-controls";
import { DesignScreen } from "@/components/design-screen";
import { SellerCard } from "@/components/seller-ui";
import { useStorefrontDesignStore } from "@/lib/storefront-design-store";

export default function SeoEditorScreen() {
  const seoMeta = useStorefrontDesignStore((state) => state.draft.seoMeta);
  const update = useStorefrontDesignStore((state) => state.update);

  const patch = (key: string, value: unknown) => {
    update((current) => {
      const next = { ...(current.seoMeta ?? {}) } as Record<string, unknown>;
      if (value === undefined) delete next[key];
      else next[key] = value;
      return {
        ...current,
        seoMeta: Object.keys(next).length > 0 ? next : undefined,
      };
    });
  };

  return (
    <DesignScreen
      title="SEO & sharing"
      description="How your stall appears in search results and link previews."
    >
      <SellerCard>
        <DesignSectionTitle title="Search metadata" />
        <ToggleRow
          label="Auto-generate from my stall"
          description="Let the storefront build titles and descriptions for you."
          value={seoMeta?.autoGenerate === true}
          onChange={(value) => patch("autoGenerate", value ? true : undefined)}
        />
        <DesignTextField
          label="Meta title"
          value={seoMeta?.metaTitle}
          onChange={(value) => patch("metaTitle", value)}
        />
        <DesignTextField
          label="Meta description"
          value={seoMeta?.metaDescription}
          multiline
          onChange={(value) => patch("metaDescription", value)}
        />
        <DesignTextField
          label="Social preview image URL"
          value={seoMeta?.ogImage}
          keyboardType="url"
          placeholder="https://…"
          onChange={(value) => patch("ogImage", value)}
        />
        <DesignTextField
          label="Keywords"
          value={seoMeta?.keywords}
          hint="Comma-separated, e.g. raw milk, farm shares, Portland"
          onChange={(value) => patch("keywords", value)}
        />
      </SellerCard>
      <SellerCard>
        <DesignSectionTitle
          title="Local discovery"
          description="Region hints for location-based search."
        />
        <DesignTextField
          label="Locale"
          value={seoMeta?.locale}
          placeholder="en_US"
          onChange={(value) => patch("locale", value)}
        />
        <DesignTextField
          label="State / region"
          value={seoMeta?.locationRegion}
          onChange={(value) => patch("locationRegion", value)}
        />
        <DesignTextField
          label="City"
          value={seoMeta?.locationCity}
          onChange={(value) => patch("locationCity", value)}
        />
      </SellerCard>
    </DesignScreen>
  );
}
