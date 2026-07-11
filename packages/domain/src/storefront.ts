export interface StorefrontColorScheme {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
}

export interface StorefrontNavColors {
  background: string;
  text: string;
  accent: string;
}

export type StorefrontNavLogoPosition = "left" | "center" | "above" | "below";
export type StorefrontNavLinkAlignment = "left" | "center" | "right";
export type StorefrontNavLinkSpacing = "compact" | "normal" | "spacious";
export type StorefrontNavUtilityPosition = "top" | "bottom";

// Controls the layout of the storefront's top navigation bar. All fields are
// optional; an absent field falls back to the historical default render
// (logo left, links right, single row) so existing published events stay
// byte-stable. logoPosition "above"/"below" stack the logo on its own row
// above/below the nav links; utilityPosition then selects which row the
// (always right-justified) cart + profile/sign-in cluster sits on.
export interface StorefrontNavLayout {
  logoPosition?: StorefrontNavLogoPosition;
  linkAlignment?: StorefrontNavLinkAlignment;
  linkSpacing?: StorefrontNavLinkSpacing;
  utilityPosition?: StorefrontNavUtilityPosition;
  // Style/behavior flags, only ever persisted as true. transparent: the nav
  // bleeds into a leading hero/banner at the top of the landing page and
  // solidifies on scroll. hideOnScroll: the nav slides away scrolling down
  // and returns scrolling up. Absent = historical solid, always-visible nav.
  transparent?: boolean;
  hideOnScroll?: boolean;
}

export interface StorefrontFooterColors {
  background: string;
  text: string;
  accent: string;
}

export interface StorefrontSocialLink {
  platform:
    | "instagram"
    | "x"
    | "facebook"
    | "youtube"
    | "tiktok"
    | "telegram"
    | "website"
    | "email"
    | "other";
  url: string;
  label?: string;
}

export interface StorefrontNavLink {
  label: string;
  href: string;
  isPage?: boolean;
}

export interface StorefrontPolicy {
  enabled: boolean;
  content: string;
}

export interface StorefrontPolicies {
  returnPolicy?: StorefrontPolicy;
  termsOfService?: StorefrontPolicy;
  privacyPolicy?: StorefrontPolicy;
  cancellationPolicy?: StorefrontPolicy;
}

export type StorefrontFooterAlignment = "left" | "center" | "right";
export type StorefrontFooterColumnLayout = "spread" | "stacked";

// Layout controls for the storefront footer, mirroring StorefrontNavLayout for
// the top nav. All fields optional; an absent field falls back to the historical
// render (spread row, centered on mobile) so existing published events stay
// byte-stable. columnLayout "stacked" centers every block in a single column.
export interface StorefrontFooterLayout {
  alignment?: StorefrontFooterAlignment;
  linkSpacing?: StorefrontNavLinkSpacing;
  columnLayout?: StorefrontFooterColumnLayout;
}

// Optional email/newsletter capture rendered in the footer. Submissions POST to
// the same /api/storefront/subscribe endpoint the contact-form subscription mode
// uses (adds the visitor to the seller's list + enrolls the welcome series).
export interface StorefrontFooterNewsletter {
  enabled?: boolean;
  headline?: string;
  subtext?: string;
  buttonText?: string;
  placeholder?: string;
  successMessage?: string;
  collectPhone?: boolean;
}

export interface StorefrontFooter {
  text?: string;
  socialLinks?: StorefrontSocialLink[];
  navLinks?: StorefrontNavLink[];
  showPoweredBy?: boolean;
  policies?: StorefrontPolicies;
  newsletter?: StorefrontFooterNewsletter;
  layout?: StorefrontFooterLayout;
}

export interface StorefrontTestimonial {
  quote: string;
  author: string;
  image?: string;
  rating?: number;
}

export interface StorefrontFaqItem {
  question: string;
  answer: string;
}

export interface StorefrontIngredientItem {
  name: string;
  description?: string;
  image?: string;
  emoji?: string;
}

export interface StorefrontComparisonColumn {
  heading: string;
  values: string[];
}

export interface StorefrontTimelineItem {
  year?: string;
  heading: string;
  body: string;
  image?: string;
}

export type StorefrontSectionType =
  | "hero"
  | "about"
  | "story"
  | "products"
  | "testimonials"
  | "faq"
  | "ingredients"
  | "comparison"
  | "text"
  | "image"
  | "banner_carousel"
  | "marquee"
  | "contact"
  | "contact_form"
  | "reviews"
  | "blog"
  | "social_posts"
  | "product_description"
  | "product_specifications"
  | "product_shipping_returns"
  | "product_gallery"
  | "related_products";

export type StorefrontSocialPostPlatform =
  | "instagram"
  | "x"
  | "facebook"
  | "youtube"
  | "tiktok"
  | "telegram"
  | "website"
  | "other";

export interface StorefrontSocialPost {
  platform: StorefrontSocialPostPlatform;
  url: string;
  caption?: string;
  image?: string;
  author?: string;
}

export interface StorefrontSpecificationItem {
  label: string;
  value: string;
}

// A single slide in a banner_carousel section. Each slide has its own image and
// optional text overlay (heading/subheading/CTA). Overlay styling (opacity,
// colors, outline) and full-bleed vs contained are section-level and shared
// across all slides, mirroring the hero section's text-over-image treatment.
export interface StorefrontBannerSlide {
  image: string;
  heading?: string;
  subheading?: string;
  ctaText?: string;
  ctaLink?: string;
}

export interface StorefrontSection {
  id: string;
  type: StorefrontSectionType;
  enabled?: boolean;
  heading?: string;
  subheading?: string;
  body?: string;
  image?: string;
  imagePosition?: "left" | "right";
  fullWidth?: boolean;
  ctaText?: string;
  ctaLink?: string;
  overlayOpacity?: number;
  headingColor?: string;
  subheadingColor?: string;
  textOutlineColor?: string;
  items?: StorefrontFaqItem[];
  testimonials?: StorefrontTestimonial[];
  ingredientItems?: StorefrontIngredientItem[];
  comparisonFeatures?: string[];
  comparisonColumns?: StorefrontComparisonColumn[];
  timelineItems?: StorefrontTimelineItem[];
  productLayout?: "grid" | "list" | "featured";
  productLimit?: number;
  productIds?: string[];
  heroProductId?: string;
  email?: string;
  phone?: string;
  address?: string;
  successMessage?: string;
  // Contact-form section behavior. "contact" (default/undefined) emails the
  // seller; "subscription" adds the visitor to the seller's email list and
  // enrolls them in the active welcome series instead. The show* flags toggle
  // individual optional inputs — Email is always shown and required, so it has
  // no flag. Undefined defaults to shown, preserving the legacy contact form.
  contactFormMode?: "contact" | "subscription";
  showNameField?: boolean;
  showPhoneField?: boolean;
  showMessageField?: boolean;
  caption?: string;
  reviewOrder?: string[];
  specifications?: StorefrontSpecificationItem[];
  shippingInfo?: string;
  returnsInfo?: string;
  galleryImages?: string[];
  useProductImages?: boolean;
  excludeCurrentProduct?: boolean;
  mergeAutoSpecs?: boolean;
  socialPosts?: StorefrontSocialPost[];
  socialPostsLayout?: "grid" | "carousel";
  socialPostsAutoplay?: boolean;
  socialPostsSpeed?: number;
  // Blog section: layout + curated/reorderable post references (by `d` tag).
  blogLayout?: "featured" | "grid" | "list";
  blogPostIds?: string[];
  blogPostLimit?: number;
  // How the blog section chooses which posts to show. "latest" (default/
  // undefined) shows newest posts first — blogPostIds may still reorder them and
  // the rest are appended — cut off at blogPostLimit. "selected" shows ONLY the
  // posts listed in blogPostIds, in that order, cut off at blogPostLimit.
  blogPostMode?: "latest" | "selected";
  // Banner carousel section: a set of rotating slides, each with its own image
  // and optional text overlay. Reuses fullWidth (full-bleed vs contained) and
  // overlayOpacity/headingColor/subheadingColor/textOutlineColor for the
  // text-over-image styling shared with the hero section.
  bannerSlides?: StorefrontBannerSlide[];
  bannerAutoplay?: boolean;
  bannerInterval?: number;
  // Marquee section: a full-width strip that continuously scrolls text and/or a
  // logo. `heading` holds the banner text (falls back to the shop/brand name
  // when empty); the shared `image` field holds an optional logo rendered inline
  // with the text; `headingColor` is the text color and `marqueeBackgroundColor`
  // the strip background (both default to the storefront theme). marqueeSpeed is
  // seconds per full scroll loop; marqueeDirection is the scroll direction
  // ("left" = default, content scrolls toward the left).
  marqueeBackgroundColor?: string;
  marqueeSpeed?: number;
  marqueeDirection?: "left" | "right";
}

export interface StorefrontProductPageConfig {
  sections?: StorefrontSection[];
  themeOverrides?: Partial<StorefrontColorScheme>;
  ogImage?: string;
  metaTitle?: string;
  metaDescription?: string;
}

export interface StorefrontPage {
  id: string;
  title: string;
  slug: string;
  sections: StorefrontSection[];
}

export interface StorefrontBlogPage {
  sections: StorefrontSection[];
}

export interface PopupFlowStep {
  id: string;
  question: string;
  answers: PopupFlowAnswer[];
}

export interface PopupFlowAnswer {
  id: string;
  label: string;
  nextStepId?: string;
}

export interface PopupStyle {
  backgroundColor?: string;
  textColor?: string;
  accentColor?: string;
  buttonColor?: string;
  buttonTextColor?: string;
  backgroundImage?: string;
  overlayOpacity?: number;
  useCustomFonts?: boolean;
}

export interface StorefrontEmailPopup {
  enabled: boolean;
  // How the popup is presented to visitors. "modal" (default) shows a centered
  // card over a dimmed page; "fullscreen" covers the whole viewport with the
  // content (and optional background image) filling the screen.
  displayMode?: "modal" | "fullscreen";
  discountPercentage: number;
  // Optional shipping discount layered on top of the product percentage.
  // 'none' (or omitted) preserves the legacy product-only welcome code.
  // 'free' waives shipping; 'percent' is `shippingDiscountValue` % off
  // shipping; 'fixed' is `shippingDiscountValue` units off shipping
  // (denominated in the buyer's cart display currency at checkout).
  shippingDiscountType?: "none" | "free" | "percent" | "fixed";
  shippingDiscountValue?: number;
  headline?: string;
  subtext?: string;
  collectPhone?: boolean;
  requirePhone?: boolean;
  buttonText?: string;
  successMessage?: string;
  style?: PopupStyle;
  flowSteps?: PopupFlowStep[];
}

export interface StorefrontSeoMeta {
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: string;
  keywords?: string;
  locale?: string;
  locationRegion?: string;
  locationCity?: string;
  autoGenerate?: boolean;
}

// The checkout payment-method buttons are grouped into three seller-orderable
// categories: "bitcoin" (Lightning / Cashu / NWC), "card" (Stripe / Square),
// and "fiat" (cash / payment app).
export type StorefrontPaymentMethodGroup = "bitcoin" | "card" | "fiat";

export const DEFAULT_PAYMENT_METHOD_ORDER: StorefrontPaymentMethodGroup[] = [
  "bitcoin",
  "card",
  "fiat",
];

// Returns a complete, de-duplicated ordering of the payment-method groups.
// Unknown or duplicate entries are dropped, and any group the seller omitted is
// appended in the default order — so partial configs (and any groups added in
// the future) still render. Passing undefined yields the default order.
export function orderedPaymentMethodGroups(
  order?: StorefrontPaymentMethodGroup[]
): StorefrontPaymentMethodGroup[] {
  if (!order || order.length === 0) return [...DEFAULT_PAYMENT_METHOD_ORDER];
  const seen = new Set<StorefrontPaymentMethodGroup>();
  const result: StorefrontPaymentMethodGroup[] = [];
  for (const group of order) {
    if (DEFAULT_PAYMENT_METHOD_ORDER.includes(group) && !seen.has(group)) {
      seen.add(group);
      result.push(group);
    }
  }
  for (const group of DEFAULT_PAYMENT_METHOD_ORDER) {
    if (!seen.has(group)) result.push(group);
  }
  return result;
}

export interface StorefrontConfig {
  colorScheme?: StorefrontColorScheme;
  productLayout?: "grid" | "list" | "featured";
  landingPageStyle?: "classic" | "hero" | "minimal";
  // When set to "product", the stall/custom-domain root serves a single
  // product's page (CheckoutCard + ProductPageRenderer) instead of the normal
  // landing page. `landingProductDTag` references the product by its replaceable
  // 'd' tag (stable across edits, unlike slugs/event ids).
  landingPageMode?: "default" | "product";
  landingProductDTag?: string;
  shopSlug?: string;
  customDomain?: string;
  fontHeading?: string;
  fontBody?: string;
  customFontHeadingUrl?: string;
  customFontHeadingName?: string;
  customFontBodyUrl?: string;
  customFontBodyName?: string;
  neoShadows?: boolean;
  sections?: StorefrontSection[];
  pages?: StorefrontPage[];
  footer?: StorefrontFooter;
  navLinks?: StorefrontNavLink[];
  // Hide the built-in "Shop"/"Stall" link that is otherwise auto-injected into
  // the storefront navigation. Undefined/false = shown (default, backward-compat).
  hideShopLink?: boolean;
  showCommunityPage?: boolean;
  showWalletPage?: boolean;
  // When true, the storefront exposes a "Blog" page: a nav link to /blog plus
  // the /blog route. The /blog index renders blogPage.sections (defaulting to a
  // single blog section) like a custom page; /blog/<slug> renders the article.
  showBlogPage?: boolean;
  blogPage?: StorefrontBlogPage;
  emailPopup?: StorefrontEmailPopup;
  navColors?: StorefrontNavColors;
  navLayout?: StorefrontNavLayout;
  footerColors?: StorefrontFooterColors;
  seoMeta?: StorefrontSeoMeta;
  productPageDefaults?: StorefrontSection[];
  // Seller-chosen order of the checkout payment-method buttons, by category:
  // "bitcoin" (Lightning/Cashu/NWC), "card" (Stripe/Square), "fiat" (cash /
  // payment app). Categories omitted here are appended in the default order
  // (bitcoin, card, fiat). Undefined = default order.
  paymentMethodOrder?: StorefrontPaymentMethodGroup[];
  // When false, the storefront hides every Bitcoin checkout button (Lightning,
  // Cashu, NWC). This is only honored at checkout when the seller actually has a
  // card or fiat method available (fail-safe: a buyer is never left with no way
  // to pay). Undefined/true = Bitcoin accepted (default, backward-compat).
  acceptBitcoin?: boolean;
}
