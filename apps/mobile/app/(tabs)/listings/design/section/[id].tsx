import { useLocalSearchParams } from "expo-router";

import { DesignHint } from "@/components/design-controls";
import { ProductDesignScreen } from "@/components/product-design-screen";
import {
  SectionFieldsEditor,
  writeValue,
} from "@/components/section-fields-editor";
import { SellerCard } from "@/components/seller-ui";
import { SECTION_TYPE_LABELS } from "@/lib/section-field-specs";
import { useProductPageDesignStore } from "@/lib/product-page-design-store";

// Field editor for one section of a product's own page design. Same
// spec-driven editor as the shop design screens — only the store differs
// (the listing's page_config draft instead of the storefront config).
export default function ProductPageSectionEditorScreen() {
  const params = useLocalSearchParams<{ id: string; listingId?: string }>();
  const listingId = params.listingId ?? "";
  const draft = useProductPageDesignStore((state) => state.draft);
  const storeListingId = useProductPageDesignStore((state) => state.listingId);
  const update = useProductPageDesignStore((state) => state.update);

  const section = draft.sections.find((entry) => entry.id === params.id);

  return (
    <ProductDesignScreen
      listingId={listingId}
      title={
        section
          ? (SECTION_TYPE_LABELS[section.type] ?? section.type)
          : "Section"
      }
      description="Edits apply when you tap Save page design."
    >
      {!section || storeListingId !== listingId ? (
        <SellerCard>
          <DesignHint text="This section isn't loaded — reopen it from the listing's page design screen." />
        </SellerCard>
      ) : (
        <SectionFieldsEditor
          section={section}
          onPatch={(key, value) =>
            update((current) => ({
              ...current,
              sections: current.sections.map((entry) =>
                entry.id === section.id ? writeValue(entry, key, value) : entry
              ),
            }))
          }
        />
      )}
    </ProductDesignScreen>
  );
}
