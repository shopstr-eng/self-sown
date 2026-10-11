import { Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";

import {
  DesignSectionTitle,
  DesignTextField,
} from "@/components/design-controls";
import { DesignScreen } from "@/components/design-screen";
import { SectionListEditor } from "@/components/section-list-editor";
import { SellerCard } from "@/components/seller-ui";
import { HOME_SECTION_TYPES } from "@/lib/section-field-specs";
import { useStorefrontDesignStore } from "@/lib/storefront-design-store";
import { sellerFonts } from "@/theme/tokens";
import { StyleSheet } from "react-native";

// Keep in sync with RESERVED_PAGE_SLUGS in utils/storefront-links.ts (web) —
// a custom page can never take a built-in, gated, or policy slug because the
// renderer resolves those first.
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "shop",
  "orders",
  "blog",
  "my-listings",
  "order-confirmation",
  "wallet",
  "community",
  "return-policy",
  "terms-of-service",
  "privacy-policy",
  "cancellation-policy",
]);

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export default function PageEditorScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const page = useStorefrontDesignStore((state) =>
    (state.draft.pages ?? []).find((entry) => entry.id === params.id)
  );
  const update = useStorefrontDesignStore((state) => state.update);

  if (!page) {
    return (
      <DesignScreen
        title="Page not found"
        description="This page may have been removed. Go back and reopen the list."
      >
        <View />
      </DesignScreen>
    );
  }

  const slugTouched = page.slug.trim() !== "";
  const slugInvalid =
    slugTouched && (!SLUG_RE.test(page.slug) || RESERVED_SLUGS.has(page.slug));

  const patch = (key: "title" | "slug", value: string) => {
    update((current) => ({
      ...current,
      pages: (current.pages ?? []).map((entry) =>
        entry.id === page.id ? { ...entry, [key]: value } : entry
      ),
    }));
  };

  return (
    <DesignScreen
      title={page.title || "Custom page"}
      description={`Lives at /${page.slug || "…"} on your storefront.`}
    >
      <SellerCard>
        <DesignSectionTitle title="Page settings" />
        <DesignTextField
          label="Title"
          value={page.title}
          onChange={(value) => patch("title", value ?? "")}
        />
        <DesignTextField
          label="URL slug"
          value={page.slug}
          placeholder="wholesale"
          hint="Lowercase letters, numbers, and dashes."
          onChange={(value) => patch("slug", (value ?? "").toLowerCase())}
        />
        {slugInvalid ? (
          <Text style={styles.slugError}>
            That slug is reserved or invalid — pick another (lowercase, dashes,
            no spaces).
          </Text>
        ) : null}
      </SellerCard>
      <SellerCard>
        <DesignSectionTitle title="Page sections" />
        <SectionListEditor
          scope={`page:${page.id}`}
          allowedTypes={HOME_SECTION_TYPES}
        />
      </SellerCard>
    </DesignScreen>
  );
}

const styles = StyleSheet.create({
  slugError: {
    color: "#c0392b",
    fontSize: 12,
    fontFamily: sellerFonts.regular,
    marginBottom: 10,
  },
});
