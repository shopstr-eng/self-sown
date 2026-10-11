import { DesignScreen } from "@/components/design-screen";
import { SectionListEditor } from "@/components/section-list-editor";
import { SellerCard } from "@/components/seller-ui";
import { PRODUCT_PAGE_SECTION_TYPES } from "@/lib/section-field-specs";

export default function ProductPageDesignScreen() {
  return (
    <DesignScreen
      title="Product page defaults"
      description="Every product page starts with these sections. Per-product overrides stay in web settings."
    >
      <SellerCard>
        <SectionListEditor
          scope="productDefaults"
          allowedTypes={PRODUCT_PAGE_SECTION_TYPES}
        />
      </SellerCard>
    </DesignScreen>
  );
}
