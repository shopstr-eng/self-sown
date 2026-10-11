import { DesignScreen } from "@/components/design-screen";
import { SectionListEditor } from "@/components/section-list-editor";
import { SellerCard } from "@/components/seller-ui";
import { HOME_SECTION_TYPES } from "@/lib/section-field-specs";

export default function HomeSectionsScreen() {
  return (
    <DesignScreen
      title="Home page sections"
      description="The building blocks of your storefront's front page, top to bottom."
    >
      <SellerCard>
        <SectionListEditor scope="home" allowedTypes={HOME_SECTION_TYPES} />
      </SellerCard>
    </DesignScreen>
  );
}
