import { DesignHint } from "@/components/design-controls";
import { DesignScreen } from "@/components/design-screen";
import { SectionListEditor } from "@/components/section-list-editor";
import { SellerCard } from "@/components/seller-ui";
import { HOME_SECTION_TYPES } from "@/lib/section-field-specs";
import { useStorefrontDesignStore } from "@/lib/storefront-design-store";

export default function BlogPageDesignScreen() {
  const showBlogPage = useStorefrontDesignStore(
    (state) => state.draft.showBlogPage === true
  );

  return (
    <DesignScreen
      title="Blog page"
      description="Sections rendered on your storefront's blog index, above and around the post list."
    >
      {!showBlogPage ? (
        <DesignHint text="The Blog page is currently hidden — enable “Show Blog page” under Navigation to publish it." />
      ) : null}
      <SellerCard>
        <SectionListEditor scope="blog" allowedTypes={HOME_SECTION_TYPES} />
      </SellerCard>
    </DesignScreen>
  );
}
