import { StorefrontSection, StorefrontColorScheme } from "@/utils/types/types";
import { ProductData } from "@/utils/parsers/product-parser-functions";
import SectionHero from "./sections/section-hero";
import SectionAbout from "./sections/section-about";
import SectionStory from "./sections/section-story";
import SectionProducts from "./sections/section-products";
import SectionTestimonials from "./sections/section-testimonials";
import SectionFaq from "./sections/section-faq";
import SectionIngredients from "./sections/section-ingredients";
import SectionComparison from "./sections/section-comparison";
import SectionText from "./sections/section-text";
import SectionImage from "./sections/section-image";
import SectionBannerCarousel from "./sections/section-banner-carousel";
import SectionMarquee from "./sections/section-marquee";
import SectionContact from "./sections/section-contact";
import SectionContactForm from "./sections/section-contact-form";
import SectionReviews from "./sections/section-reviews";
import SectionSocialPosts from "./sections/section-social-posts";
import SectionProductDescription from "./sections/section-product-description";
import SectionProductSpecifications from "./sections/section-product-specifications";
import SectionProductShippingReturns from "./sections/section-product-shipping-returns";
import SectionProductGallery from "./sections/section-product-gallery";
import SectionProductReviews from "./sections/section-product-reviews";
import SectionRelatedProducts from "./sections/section-related-products";
import SectionBlog from "./sections/section-blog";
import { sectionBandStyle } from "./sections/section-style";

interface SectionRendererProps {
  section: StorefrontSection;
  colors: StorefrontColorScheme;
  shopName: string;
  shopPicture?: string;
  shopPubkey: string;
  products: ProductData[];
  isPreview?: boolean;
  currentProduct?: ProductData;
  shopSlug?: string;
}

export default function SectionRenderer({
  section,
  colors,
  shopName,
  shopPicture,
  shopPubkey,
  products,
  isPreview,
  currentProduct,
  shopSlug,
}: SectionRendererProps) {
  if (section.enabled === false) return null;

  const body = renderSectionBody({
    section,
    colors,
    shopName,
    shopPicture,
    shopPubkey,
    products,
    isPreview,
    currentProduct,
    shopSlug,
  });
  if (!body) return null;

  // Optional per-section color band. Setting --sf-text re-points headings that
  // explicitly use var(--sf-text); `color` covers inherited body text. Legacy
  // sections (no custom colors) skip the wrapper entirely.
  const bandStyle = sectionBandStyle(section);
  if (!bandStyle) return body;
  return <div style={bandStyle}>{body}</div>;
}

function renderSectionBody({
  section,
  colors,
  shopName,
  shopPicture,
  shopPubkey,
  products,
  isPreview,
  currentProduct,
  shopSlug,
}: SectionRendererProps) {
  switch (section.type) {
    case "hero":
      return (
        <SectionHero
          section={section}
          colors={colors}
          shopName={shopName}
          shopPicture={shopPicture}
        />
      );
    case "about":
      return <SectionAbout section={section} colors={colors} />;
    case "story":
      return <SectionStory section={section} colors={colors} />;
    case "products":
      return (
        <SectionProducts
          section={section}
          colors={colors}
          products={products}
          isPreview={isPreview}
          shopSlug={shopSlug}
        />
      );
    case "testimonials":
      return <SectionTestimonials section={section} colors={colors} />;
    case "faq":
      return <SectionFaq section={section} colors={colors} />;
    case "ingredients":
      return <SectionIngredients section={section} colors={colors} />;
    case "comparison":
      return <SectionComparison section={section} colors={colors} />;
    case "text":
      return <SectionText section={section} colors={colors} />;
    case "image":
      return <SectionImage section={section} colors={colors} />;
    case "banner_carousel":
      return <SectionBannerCarousel section={section} colors={colors} />;
    case "marquee":
      return (
        <SectionMarquee section={section} colors={colors} shopName={shopName} />
      );
    case "contact":
      return <SectionContact section={section} colors={colors} />;
    case "contact_form":
      return (
        <SectionContactForm
          section={section}
          colors={colors}
          shopPubkey={shopPubkey}
          shopName={shopName}
          isPreview={isPreview}
        />
      );
    case "social_posts":
      return <SectionSocialPosts section={section} colors={colors} />;
    case "blog":
      return (
        <SectionBlog
          section={section}
          colors={colors}
          shopPubkey={shopPubkey}
          shopSlug={shopSlug}
          isPreview={isPreview}
        />
      );
    case "reviews":
      if (currentProduct?.d) {
        return (
          <SectionProductReviews
            section={section}
            colors={colors}
            shopPubkey={shopPubkey}
            productDTag={currentProduct.d}
          />
        );
      }
      return (
        <SectionReviews
          section={section}
          colors={colors}
          shopPubkey={shopPubkey}
        />
      );
    case "product_description":
      if (!currentProduct) return null;
      return (
        <SectionProductDescription
          section={section}
          colors={colors}
          product={currentProduct}
        />
      );
    case "product_specifications":
      if (!currentProduct) return null;
      return (
        <SectionProductSpecifications
          section={section}
          colors={colors}
          product={currentProduct}
        />
      );
    case "product_shipping_returns":
      if (!currentProduct) return null;
      return (
        <SectionProductShippingReturns
          section={section}
          colors={colors}
          product={currentProduct}
        />
      );
    case "product_gallery":
      if (!currentProduct) return null;
      return (
        <SectionProductGallery
          section={section}
          colors={colors}
          product={currentProduct}
        />
      );
    case "related_products":
      if (!currentProduct) return null;
      return (
        <SectionRelatedProducts
          section={section}
          colors={colors}
          products={products}
          currentProduct={currentProduct}
          shopPubkey={shopPubkey}
        />
      );
    default:
      return null;
  }
}
