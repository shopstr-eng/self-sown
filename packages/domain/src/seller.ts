import { CATEGORIES } from "./constants";
import type {
  StorefrontConfig,
  StorefrontPaymentMethodGroup,
  StorefrontSection,
} from "./storefront";

export interface NostrEventRecord {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

export type SellerAuthMethod = "email" | "nsec";

export interface SellerSession {
  authMethod: SellerAuthMethod;
  pubkey: string;
  nsec: string;
  email?: string;
  relays: string[];
  writeRelays: string[];
  createdAt: number;
}

export interface SellerShopProfileContent {
  name: string;
  about: string;
  ui: {
    picture: string;
    banner: string;
    theme: string;
    darkMode: boolean;
  };
  merchants: string[];
  freeShippingThreshold?: number;
  freeShippingCurrency?: string;
  paymentMethodDiscounts?: Record<string, number>;
  storefront?: StorefrontConfig;
}

export interface SellerShopProfile {
  pubkey: string;
  content: SellerShopProfileContent;
  createdAt: number;
  notificationEmail?: string | null;
  rawEvent?: NostrEventRecord;
}

export interface StorefrontBasicsDraft {
  shopName: string;
  about: string;
  notificationEmail: string;
  shopSlug: string;
}

export interface StorefrontBasicsValidationErrors {
  shopName?: string;
  about?: string;
  notificationEmail?: string;
  shopSlug?: string;
}

export interface StorefrontSlugState {
  value: string;
  status: "idle" | "saving" | "saved" | "error";
  error?: string;
}

export interface SellerListingSummary {
  id: string;
  pubkey: string;
  createdAt: number;
  title: string;
  status: string;
  price: number | null;
  currency: string | null;
  categories: string[];
  primaryCategory: string | null;
  dTag?: string;
}

export interface StripeConnectStatus {
  hasAccount: boolean;
  accountId?: string;
  onboardingComplete: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
}

export const DEFAULT_SELLER_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://purplepag.es",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
] as const;

const RESERVED_MARKETPLACE_TAGS = new Set([
  "MilkMarket",
  "FREEMILK",
  "SAVEBEEF",
]);
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STOREFRONT_PRODUCT_LAYOUTS = new Set(["grid", "list", "featured"]);
const STOREFRONT_LANDING_PAGE_STYLES = new Set(["classic", "hero", "minimal"]);
const STOREFRONT_LANDING_PAGE_MODES = new Set(["default", "product"]);
const STOREFRONT_IMAGE_POSITIONS = new Set(["left", "right"]);
const STOREFRONT_NAV_LOGO_POSITIONS = new Set([
  "left",
  "center",
  "above",
  "below",
]);
const STOREFRONT_NAV_LINK_ALIGNMENTS = new Set(["left", "center", "right"]);
const STOREFRONT_NAV_LINK_SPACINGS = new Set(["compact", "normal", "spacious"]);
const STOREFRONT_NAV_UTILITY_POSITIONS = new Set(["top", "bottom"]);
const STOREFRONT_FOOTER_COLUMN_LAYOUTS = new Set(["spread", "stacked"]);
const STOREFRONT_SECTION_TYPES = new Set([
  "hero",
  "about",
  "story",
  "products",
  "testimonials",
  "faq",
  "ingredients",
  "comparison",
  "text",
  "image",
  "banner_carousel",
  "marquee",
  "social_posts",
  "contact",
  "contact_form",
  "reviews",
  "blog",
]);
const STOREFRONT_SOCIAL_POST_PLATFORMS = new Set([
  "instagram",
  "x",
  "facebook",
  "youtube",
  "tiktok",
  "telegram",
  "website",
  "other",
]);
const STOREFRONT_SOCIAL_POSTS_LAYOUTS = new Set(["grid", "carousel"]);
const STOREFRONT_MARQUEE_DIRECTIONS = new Set(["left", "right"]);
const STOREFRONT_BLOG_LAYOUTS = new Set(["featured", "grid", "list"]);
const STOREFRONT_BLOG_MODES = new Set(["latest", "selected"]);
const STOREFRONT_CONTACT_FORM_MODES = new Set(["contact", "subscription"]);
const STOREFRONT_SOCIAL_PLATFORMS = new Set([
  "instagram",
  "x",
  "facebook",
  "youtube",
  "tiktok",
  "telegram",
  "website",
  "email",
  "other",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonContent(rawContent: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawContent) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getTagValues(event: NostrEventRecord, key: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === key && typeof tag[1] === "string")
    .map((tag) => tag[1] as string);
}

function isValidNotificationEmail(email: string): boolean {
  if (!email.trim()) {
    return true;
  }

  return EMAIL_REGEX.test(email.trim());
}

export function normalizeStorefrontSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 63)
    .replace(/^-|-$/g, "");
}

// Full storefront-section sanitizer shared by the homepage `sections[]` and the
// dedicated `blogPage.sections[]` so the blog index page keeps the same rich
// field set (the custom `pages[]` sanitizer below is intentionally reduced).
function sanitizeFullSection(section: Record<string, unknown>) {
  return {
    id: typeof section.id === "string" ? section.id : "",
    type:
      typeof section.type === "string" &&
      STOREFRONT_SECTION_TYPES.has(section.type)
        ? (section.type as
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
            | "social_posts"
            | "contact"
            | "contact_form"
            | "reviews"
            | "blog")
        : "text",
    ...(typeof section.enabled === "boolean"
      ? { enabled: section.enabled }
      : {}),
    ...(typeof section.heading === "string"
      ? { heading: section.heading }
      : {}),
    ...(typeof section.subheading === "string"
      ? { subheading: section.subheading }
      : {}),
    ...(typeof section.body === "string" ? { body: section.body } : {}),
    ...(typeof section.image === "string" ? { image: section.image } : {}),
    ...(typeof section.imagePosition === "string" &&
    STOREFRONT_IMAGE_POSITIONS.has(section.imagePosition)
      ? { imagePosition: section.imagePosition as "left" | "right" }
      : {}),
    ...(typeof section.fullWidth === "boolean"
      ? { fullWidth: section.fullWidth }
      : {}),
    ...(typeof section.ctaText === "string"
      ? { ctaText: section.ctaText }
      : {}),
    ...(typeof section.ctaLink === "string"
      ? { ctaLink: section.ctaLink }
      : {}),
    ...(typeof section.overlayOpacity === "number"
      ? { overlayOpacity: section.overlayOpacity }
      : {}),
    ...(typeof section.headingColor === "string"
      ? { headingColor: section.headingColor }
      : {}),
    ...(typeof section.subheadingColor === "string"
      ? { subheadingColor: section.subheadingColor }
      : {}),
    ...(typeof section.textOutlineColor === "string"
      ? { textOutlineColor: section.textOutlineColor }
      : {}),
    ...(Array.isArray(section.items) ? { items: section.items } : {}),
    ...(Array.isArray(section.testimonials)
      ? { testimonials: section.testimonials }
      : {}),
    ...(Array.isArray(section.ingredientItems)
      ? { ingredientItems: section.ingredientItems }
      : {}),
    ...(Array.isArray(section.comparisonFeatures)
      ? { comparisonFeatures: section.comparisonFeatures }
      : {}),
    ...(Array.isArray(section.comparisonColumns)
      ? { comparisonColumns: section.comparisonColumns }
      : {}),
    ...(Array.isArray(section.timelineItems)
      ? { timelineItems: section.timelineItems }
      : {}),
    ...(typeof section.productLayout === "string" &&
    STOREFRONT_PRODUCT_LAYOUTS.has(section.productLayout)
      ? {
          productLayout: section.productLayout as "grid" | "list" | "featured",
        }
      : {}),
    ...(typeof section.productLimit === "number"
      ? { productLimit: section.productLimit }
      : {}),
    ...(typeof section.email === "string" ? { email: section.email } : {}),
    ...(typeof section.phone === "string" ? { phone: section.phone } : {}),
    ...(typeof section.address === "string"
      ? { address: section.address }
      : {}),
    ...(typeof section.successMessage === "string"
      ? { successMessage: section.successMessage }
      : {}),
    ...(typeof section.contactFormMode === "string" &&
    STOREFRONT_CONTACT_FORM_MODES.has(section.contactFormMode)
      ? {
          contactFormMode: section.contactFormMode as
            | "contact"
            | "subscription",
        }
      : {}),
    ...(typeof section.showNameField === "boolean"
      ? { showNameField: section.showNameField }
      : {}),
    ...(typeof section.showPhoneField === "boolean"
      ? { showPhoneField: section.showPhoneField }
      : {}),
    ...(typeof section.showMessageField === "boolean"
      ? { showMessageField: section.showMessageField }
      : {}),
    ...(typeof section.caption === "string"
      ? { caption: section.caption }
      : {}),
    ...(typeof section.blogLayout === "string" &&
    STOREFRONT_BLOG_LAYOUTS.has(section.blogLayout)
      ? {
          blogLayout: section.blogLayout as "featured" | "grid" | "list",
        }
      : {}),
    ...(Array.isArray(section.blogPostIds)
      ? {
          blogPostIds: section.blogPostIds.filter(
            (id): id is string => typeof id === "string"
          ),
        }
      : {}),
    ...(typeof section.blogPostLimit === "number"
      ? { blogPostLimit: section.blogPostLimit }
      : {}),
    ...(typeof section.blogPostMode === "string" &&
    STOREFRONT_BLOG_MODES.has(section.blogPostMode)
      ? { blogPostMode: section.blogPostMode as "latest" | "selected" }
      : {}),
    ...(Array.isArray(section.bannerSlides)
      ? {
          bannerSlides: section.bannerSlides
            .filter(isRecord)
            .map((slide) => ({
              image: typeof slide.image === "string" ? slide.image : "",
              ...(typeof slide.heading === "string"
                ? { heading: slide.heading }
                : {}),
              ...(typeof slide.subheading === "string"
                ? { subheading: slide.subheading }
                : {}),
              ...(typeof slide.ctaText === "string"
                ? { ctaText: slide.ctaText }
                : {}),
              ...(typeof slide.ctaLink === "string"
                ? { ctaLink: slide.ctaLink }
                : {}),
            }))
            .filter((slide) => slide.image),
        }
      : {}),
    ...(typeof section.bannerAutoplay === "boolean"
      ? { bannerAutoplay: section.bannerAutoplay }
      : {}),
    ...(typeof section.bannerInterval === "number"
      ? { bannerInterval: section.bannerInterval }
      : {}),
    ...(Array.isArray(section.socialPosts)
      ? {
          socialPosts: section.socialPosts
            .filter(isRecord)
            .map((post) => ({
              platform:
                typeof post.platform === "string" &&
                STOREFRONT_SOCIAL_POST_PLATFORMS.has(post.platform)
                  ? (post.platform as
                      | "instagram"
                      | "x"
                      | "facebook"
                      | "youtube"
                      | "tiktok"
                      | "telegram"
                      | "website"
                      | "other")
                  : ("other" as const),
              url: typeof post.url === "string" ? post.url : "",
              ...(typeof post.caption === "string"
                ? { caption: post.caption }
                : {}),
              ...(typeof post.image === "string" ? { image: post.image } : {}),
              ...(typeof post.author === "string"
                ? { author: post.author }
                : {}),
            }))
            .filter((post) => post.url),
        }
      : {}),
    ...(typeof section.socialPostsLayout === "string" &&
    STOREFRONT_SOCIAL_POSTS_LAYOUTS.has(section.socialPostsLayout)
      ? { socialPostsLayout: section.socialPostsLayout as "grid" | "carousel" }
      : {}),
    ...(typeof section.socialPostsAutoplay === "boolean"
      ? { socialPostsAutoplay: section.socialPostsAutoplay }
      : {}),
    ...(typeof section.socialPostsSpeed === "number"
      ? { socialPostsSpeed: section.socialPostsSpeed }
      : {}),
    ...(typeof section.marqueeBackgroundColor === "string"
      ? { marqueeBackgroundColor: section.marqueeBackgroundColor }
      : {}),
    ...(typeof section.marqueeSpeed === "number"
      ? { marqueeSpeed: section.marqueeSpeed }
      : {}),
    ...(typeof section.marqueeDirection === "string" &&
    STOREFRONT_MARQUEE_DIRECTIONS.has(section.marqueeDirection)
      ? { marqueeDirection: section.marqueeDirection as "left" | "right" }
      : {}),
  };
}

function normalizeStorefrontConfig(
  value: unknown
): StorefrontConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const colorScheme =
    isRecord(value.colorScheme) &&
    typeof value.colorScheme.primary === "string" &&
    typeof value.colorScheme.secondary === "string" &&
    typeof value.colorScheme.accent === "string" &&
    typeof value.colorScheme.background === "string" &&
    typeof value.colorScheme.text === "string"
      ? {
          primary: value.colorScheme.primary,
          secondary: value.colorScheme.secondary,
          accent: value.colorScheme.accent,
          background: value.colorScheme.background,
          text: value.colorScheme.text,
        }
      : undefined;

  const navLinks = Array.isArray(value.navLinks)
    ? value.navLinks
        .filter(isRecord)
        .map((link) => ({
          label: typeof link.label === "string" ? link.label : "",
          href: typeof link.href === "string" ? link.href : "",
          ...(typeof link.isPage === "boolean" ? { isPage: link.isPage } : {}),
        }))
        .filter((link) => link.label && link.href)
    : undefined;

  const navLayout = isRecord(value.navLayout)
    ? {
        ...(typeof value.navLayout.logoPosition === "string" &&
        STOREFRONT_NAV_LOGO_POSITIONS.has(value.navLayout.logoPosition)
          ? {
              logoPosition: value.navLayout.logoPosition as
                | "left"
                | "center"
                | "above"
                | "below",
            }
          : {}),
        ...(typeof value.navLayout.linkAlignment === "string" &&
        STOREFRONT_NAV_LINK_ALIGNMENTS.has(value.navLayout.linkAlignment)
          ? {
              linkAlignment: value.navLayout.linkAlignment as
                | "left"
                | "center"
                | "right",
            }
          : {}),
        ...(typeof value.navLayout.linkSpacing === "string" &&
        STOREFRONT_NAV_LINK_SPACINGS.has(value.navLayout.linkSpacing)
          ? {
              linkSpacing: value.navLayout.linkSpacing as
                | "compact"
                | "normal"
                | "spacious",
            }
          : {}),
        ...(typeof value.navLayout.utilityPosition === "string" &&
        STOREFRONT_NAV_UTILITY_POSITIONS.has(value.navLayout.utilityPosition)
          ? {
              utilityPosition: value.navLayout.utilityPosition as
                | "top"
                | "bottom",
            }
          : {}),
        ...(value.navLayout.transparent === true ? { transparent: true } : {}),
        ...(value.navLayout.hideOnScroll === true
          ? { hideOnScroll: true }
          : {}),
      }
    : undefined;

  const footer = isRecord(value.footer)
    ? {
        ...(typeof value.footer.text === "string"
          ? { text: value.footer.text }
          : {}),
        ...(typeof value.footer.showPoweredBy === "boolean"
          ? { showPoweredBy: value.footer.showPoweredBy }
          : {}),
        ...(Array.isArray(value.footer.navLinks)
          ? {
              navLinks: value.footer.navLinks
                .filter(isRecord)
                .map((link) => ({
                  label: typeof link.label === "string" ? link.label : "",
                  href: typeof link.href === "string" ? link.href : "",
                  ...(typeof link.isPage === "boolean"
                    ? { isPage: link.isPage }
                    : {}),
                }))
                .filter((link) => link.label && link.href),
            }
          : {}),
        ...(Array.isArray(value.footer.socialLinks)
          ? {
              socialLinks: value.footer.socialLinks
                .filter(isRecord)
                .map((link) => ({
                  platform:
                    typeof link.platform === "string" &&
                    STOREFRONT_SOCIAL_PLATFORMS.has(link.platform)
                      ? (link.platform as
                          | "instagram"
                          | "x"
                          | "facebook"
                          | "youtube"
                          | "tiktok"
                          | "telegram"
                          | "website"
                          | "email"
                          | "other")
                      : "other",
                  url: typeof link.url === "string" ? link.url : "",
                  ...(typeof link.label === "string"
                    ? { label: link.label }
                    : {}),
                }))
                .filter((link) => link.url),
            }
          : {}),
        ...(isRecord(value.footer.policies)
          ? {
              policies: {
                ...(isRecord(value.footer.policies.returnPolicy) &&
                typeof value.footer.policies.returnPolicy.enabled ===
                  "boolean" &&
                typeof value.footer.policies.returnPolicy.content === "string"
                  ? {
                      returnPolicy: {
                        enabled: value.footer.policies.returnPolicy.enabled,
                        content: value.footer.policies.returnPolicy.content,
                      },
                    }
                  : {}),
                ...(isRecord(value.footer.policies.termsOfService) &&
                typeof value.footer.policies.termsOfService.enabled ===
                  "boolean" &&
                typeof value.footer.policies.termsOfService.content === "string"
                  ? {
                      termsOfService: {
                        enabled: value.footer.policies.termsOfService.enabled,
                        content: value.footer.policies.termsOfService.content,
                      },
                    }
                  : {}),
                ...(isRecord(value.footer.policies.privacyPolicy) &&
                typeof value.footer.policies.privacyPolicy.enabled ===
                  "boolean" &&
                typeof value.footer.policies.privacyPolicy.content === "string"
                  ? {
                      privacyPolicy: {
                        enabled: value.footer.policies.privacyPolicy.enabled,
                        content: value.footer.policies.privacyPolicy.content,
                      },
                    }
                  : {}),
                ...(isRecord(value.footer.policies.cancellationPolicy) &&
                typeof value.footer.policies.cancellationPolicy.enabled ===
                  "boolean" &&
                typeof value.footer.policies.cancellationPolicy.content ===
                  "string"
                  ? {
                      cancellationPolicy: {
                        enabled:
                          value.footer.policies.cancellationPolicy.enabled,
                        content:
                          value.footer.policies.cancellationPolicy.content,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        ...(isRecord(value.footer.newsletter)
          ? {
              newsletter: {
                ...(typeof value.footer.newsletter.enabled === "boolean"
                  ? { enabled: value.footer.newsletter.enabled }
                  : {}),
                ...(typeof value.footer.newsletter.headline === "string"
                  ? { headline: value.footer.newsletter.headline }
                  : {}),
                ...(typeof value.footer.newsletter.subtext === "string"
                  ? { subtext: value.footer.newsletter.subtext }
                  : {}),
                ...(typeof value.footer.newsletter.buttonText === "string"
                  ? { buttonText: value.footer.newsletter.buttonText }
                  : {}),
                ...(typeof value.footer.newsletter.placeholder === "string"
                  ? { placeholder: value.footer.newsletter.placeholder }
                  : {}),
                ...(typeof value.footer.newsletter.successMessage === "string"
                  ? {
                      successMessage: value.footer.newsletter.successMessage,
                    }
                  : {}),
                ...(typeof value.footer.newsletter.collectPhone === "boolean"
                  ? { collectPhone: value.footer.newsletter.collectPhone }
                  : {}),
              },
            }
          : {}),
        ...(isRecord(value.footer.layout)
          ? {
              layout: {
                ...(typeof value.footer.layout.alignment === "string" &&
                STOREFRONT_NAV_LINK_ALIGNMENTS.has(
                  value.footer.layout.alignment
                )
                  ? {
                      alignment: value.footer.layout.alignment as
                        | "left"
                        | "center"
                        | "right",
                    }
                  : {}),
                ...(typeof value.footer.layout.linkSpacing === "string" &&
                STOREFRONT_NAV_LINK_SPACINGS.has(
                  value.footer.layout.linkSpacing
                )
                  ? {
                      linkSpacing: value.footer.layout.linkSpacing as
                        | "compact"
                        | "normal"
                        | "spacious",
                    }
                  : {}),
                ...(typeof value.footer.layout.columnLayout === "string" &&
                STOREFRONT_FOOTER_COLUMN_LAYOUTS.has(
                  value.footer.layout.columnLayout
                )
                  ? {
                      columnLayout: value.footer.layout.columnLayout as
                        | "spread"
                        | "stacked",
                    }
                  : {}),
              },
            }
          : {}),
      }
    : undefined;

  const sections = Array.isArray(value.sections)
    ? value.sections
        .filter(isRecord)
        .map(sanitizeFullSection)
        .filter((section) => section.id)
    : undefined;

  const blogPage =
    isRecord(value.blogPage) && Array.isArray(value.blogPage.sections)
      ? {
          sections: value.blogPage.sections
            .filter(isRecord)
            .map(sanitizeFullSection)
            .filter((section) => section.id),
        }
      : undefined;

  const pages = Array.isArray(value.pages)
    ? value.pages
        .filter(isRecord)
        .map((page) => ({
          id: typeof page.id === "string" ? page.id : "",
          title: typeof page.title === "string" ? page.title : "",
          slug: typeof page.slug === "string" ? page.slug : "",
          sections: Array.isArray(page.sections)
            ? page.sections.filter(isRecord).map((section) => ({
                id: typeof section.id === "string" ? section.id : "",
                type:
                  typeof section.type === "string" &&
                  STOREFRONT_SECTION_TYPES.has(section.type)
                    ? (section.type as
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
                        | "contact"
                        | "contact_form"
                        | "reviews"
                        | "blog")
                    : "text",
                ...(typeof section.enabled === "boolean"
                  ? { enabled: section.enabled }
                  : {}),
                ...(typeof section.heading === "string"
                  ? { heading: section.heading }
                  : {}),
                ...(typeof section.subheading === "string"
                  ? { subheading: section.subheading }
                  : {}),
                ...(typeof section.body === "string"
                  ? { body: section.body }
                  : {}),
                ...(typeof section.ctaText === "string"
                  ? { ctaText: section.ctaText }
                  : {}),
                ...(typeof section.headingColor === "string"
                  ? { headingColor: section.headingColor }
                  : {}),
                ...(typeof section.successMessage === "string"
                  ? { successMessage: section.successMessage }
                  : {}),
                ...(typeof section.contactFormMode === "string" &&
                STOREFRONT_CONTACT_FORM_MODES.has(section.contactFormMode)
                  ? {
                      contactFormMode: section.contactFormMode as
                        | "contact"
                        | "subscription",
                    }
                  : {}),
                ...(typeof section.showNameField === "boolean"
                  ? { showNameField: section.showNameField }
                  : {}),
                ...(typeof section.showPhoneField === "boolean"
                  ? { showPhoneField: section.showPhoneField }
                  : {}),
                ...(typeof section.showMessageField === "boolean"
                  ? { showMessageField: section.showMessageField }
                  : {}),
                ...(typeof section.blogLayout === "string" &&
                STOREFRONT_BLOG_LAYOUTS.has(section.blogLayout)
                  ? {
                      blogLayout: section.blogLayout as
                        | "featured"
                        | "grid"
                        | "list",
                    }
                  : {}),
                ...(Array.isArray(section.blogPostIds)
                  ? {
                      blogPostIds: section.blogPostIds.filter(
                        (id): id is string => typeof id === "string"
                      ),
                    }
                  : {}),
                ...(typeof section.blogPostLimit === "number"
                  ? { blogPostLimit: section.blogPostLimit }
                  : {}),
                ...(typeof section.blogPostMode === "string" &&
                STOREFRONT_BLOG_MODES.has(section.blogPostMode)
                  ? {
                      blogPostMode: section.blogPostMode as
                        | "latest"
                        | "selected",
                    }
                  : {}),
              }))
            : [],
        }))
        .filter((page) => page.id && page.title && page.slug)
    : undefined;

  // Product-page default sections pass through as-is (they can contain
  // product-scoped types like product_gallery that the homepage/page
  // sanitizers would downgrade). Render paths read the raw config anyway;
  // this keeps them visible to server consumers (e.g. the contact-form and
  // subscribe anti-abuse gates) instead of silently dropping them.
  const productPageDefaults = Array.isArray(value.productPageDefaults)
    ? (value.productPageDefaults.filter(
        isRecord
      ) as unknown as StorefrontSection[])
    : undefined;

  const paymentMethodOrder = Array.isArray(value.paymentMethodOrder)
    ? (value.paymentMethodOrder.filter(
        (group, index, arr) =>
          (group === "bitcoin" || group === "card" || group === "fiat") &&
          arr.indexOf(group) === index
      ) as StorefrontPaymentMethodGroup[])
    : undefined;

  const acceptBitcoin =
    typeof value.acceptBitcoin === "boolean" ? value.acceptBitcoin : undefined;

  const normalized: StorefrontConfig = {
    ...(colorScheme ? { colorScheme } : {}),
    ...(typeof value.productLayout === "string" &&
    STOREFRONT_PRODUCT_LAYOUTS.has(value.productLayout)
      ? {
          productLayout: value.productLayout as "grid" | "list" | "featured",
        }
      : {}),
    ...(typeof value.landingPageStyle === "string" &&
    STOREFRONT_LANDING_PAGE_STYLES.has(value.landingPageStyle)
      ? {
          landingPageStyle: value.landingPageStyle as
            | "classic"
            | "hero"
            | "minimal",
        }
      : {}),
    ...(typeof value.landingPageMode === "string" &&
    STOREFRONT_LANDING_PAGE_MODES.has(value.landingPageMode)
      ? {
          landingPageMode: value.landingPageMode as "default" | "product",
        }
      : {}),
    ...(typeof value.landingProductDTag === "string" &&
    value.landingProductDTag.length > 0
      ? { landingProductDTag: value.landingProductDTag }
      : {}),
    ...(typeof value.shopSlug === "string" ? { shopSlug: value.shopSlug } : {}),
    ...(typeof value.customDomain === "string"
      ? { customDomain: value.customDomain }
      : {}),
    ...(typeof value.fontHeading === "string"
      ? { fontHeading: value.fontHeading }
      : {}),
    ...(typeof value.fontBody === "string" ? { fontBody: value.fontBody } : {}),
    ...(sections && sections.length > 0 ? { sections } : {}),
    ...(pages && pages.length > 0 ? { pages } : {}),
    ...(footer && Object.keys(footer).length > 0 ? { footer } : {}),
    ...(navLinks && navLinks.length > 0 ? { navLinks } : {}),
    ...(navLayout && Object.keys(navLayout).length > 0 ? { navLayout } : {}),
    ...(typeof value.showCommunityPage === "boolean"
      ? { showCommunityPage: value.showCommunityPage }
      : {}),
    ...(typeof value.showWalletPage === "boolean"
      ? { showWalletPage: value.showWalletPage }
      : {}),
    ...(typeof value.showBlogPage === "boolean"
      ? { showBlogPage: value.showBlogPage }
      : {}),
    ...(blogPage && blogPage.sections.length > 0 ? { blogPage } : {}),
    ...(productPageDefaults && productPageDefaults.length > 0
      ? { productPageDefaults }
      : {}),
    ...(paymentMethodOrder && paymentMethodOrder.length > 0
      ? { paymentMethodOrder }
      : {}),
    // Only persist when explicitly disabled; undefined/true stays absent so the
    // default (Bitcoin accepted) is preserved and events stay byte-stable.
    ...(acceptBitcoin === false ? { acceptBitcoin: false } : {}),
  };

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function createEmptyStorefrontBasicsDraft(): StorefrontBasicsDraft {
  return {
    shopName: "",
    about: "",
    notificationEmail: "",
    shopSlug: "",
  };
}

export function validateStorefrontBasicsDraft(
  draft: StorefrontBasicsDraft
): StorefrontBasicsValidationErrors {
  const errors: StorefrontBasicsValidationErrors = {};

  if (!draft.shopName.trim()) {
    errors.shopName = "Shop name is required.";
  } else if (draft.shopName.trim().length > 50) {
    errors.shopName = "Shop name must be 50 characters or fewer.";
  }

  if (draft.about.trim().length > 500) {
    errors.about = "About must be 500 characters or fewer.";
  }

  if (!isValidNotificationEmail(draft.notificationEmail)) {
    errors.notificationEmail = "Enter a valid email address.";
  }

  const normalizedSlug = normalizeStorefrontSlug(draft.shopSlug);
  if (draft.shopSlug.trim() && normalizedSlug.length < 2) {
    errors.shopSlug = "Shop slug must be at least 2 characters.";
  }

  return errors;
}

export function buildSellerShopProfileContent(params: {
  existingContent?: SellerShopProfileContent;
  draft: StorefrontBasicsDraft;
  pubkey: string;
}): SellerShopProfileContent {
  const normalizedSlug = normalizeStorefrontSlug(params.draft.shopSlug);
  const existingStorefront = params.existingContent?.storefront;
  const nextStorefront: StorefrontConfig | undefined = existingStorefront
    ? {
        ...existingStorefront,
        shopSlug: normalizedSlug || undefined,
      }
    : normalizedSlug
      ? {
          shopSlug: normalizedSlug,
        }
      : undefined;

  return {
    name: params.draft.shopName.trim(),
    about: params.draft.about.trim(),
    ui: {
      picture: params.existingContent?.ui.picture ?? "",
      banner: params.existingContent?.ui.banner ?? "",
      theme: params.existingContent?.ui.theme ?? "",
      darkMode: params.existingContent?.ui.darkMode ?? false,
    },
    merchants:
      params.existingContent?.merchants.length &&
      params.existingContent.merchants.length > 0
        ? params.existingContent.merchants
        : [params.pubkey],
    freeShippingThreshold: params.existingContent?.freeShippingThreshold,
    freeShippingCurrency: params.existingContent?.freeShippingCurrency,
    paymentMethodDiscounts: params.existingContent?.paymentMethodDiscounts,
    storefront: nextStorefront,
  };
}

export function parseSellerShopProfileEvent(
  event: NostrEventRecord
): SellerShopProfile | null {
  if (event.kind !== 30019) {
    return null;
  }

  const parsed = parseJsonContent(event.content);
  if (!parsed) {
    return null;
  }

  const ui = isRecord(parsed.ui) ? parsed.ui : undefined;
  const storefront = normalizeStorefrontConfig(parsed.storefront);
  const merchants = Array.isArray(parsed.merchants)
    ? parsed.merchants.filter(
        (value): value is string => typeof value === "string"
      )
    : [];

  return {
    pubkey: event.pubkey,
    createdAt: event.created_at,
    rawEvent: event,
    content: {
      name: typeof parsed.name === "string" ? parsed.name : "",
      about: typeof parsed.about === "string" ? parsed.about : "",
      ui: {
        picture: typeof ui?.picture === "string" ? ui.picture : "",
        banner: typeof ui?.banner === "string" ? ui.banner : "",
        theme: typeof ui?.theme === "string" ? ui.theme : "",
        darkMode: ui?.darkMode === true,
      },
      merchants: merchants.length > 0 ? merchants : [event.pubkey],
      freeShippingThreshold:
        typeof parsed.freeShippingThreshold === "number"
          ? parsed.freeShippingThreshold
          : undefined,
      freeShippingCurrency:
        typeof parsed.freeShippingCurrency === "string"
          ? parsed.freeShippingCurrency
          : undefined,
      paymentMethodDiscounts:
        parsed.paymentMethodDiscounts &&
        typeof parsed.paymentMethodDiscounts === "object" &&
        !Array.isArray(parsed.paymentMethodDiscounts)
          ? (parsed.paymentMethodDiscounts as Record<string, number>)
          : undefined,
      storefront,
    },
  };
}

export function selectSellerShopProfile(
  events: NostrEventRecord[],
  pubkey: string
): SellerShopProfile | null {
  const matches = events
    .filter((event) => event.pubkey === pubkey)
    .map(parseSellerShopProfileEvent)
    .filter((profile): profile is SellerShopProfile => profile !== null)
    .sort((left, right) => right.createdAt - left.createdAt);

  return matches[0] ?? null;
}

export function withNotificationEmail(
  profile: SellerShopProfile | null,
  notificationEmail: string | null | undefined
): SellerShopProfile | null {
  if (!profile) {
    return null;
  }

  return {
    ...profile,
    notificationEmail: notificationEmail ?? null,
  };
}

export function buildSellerListingSummary(
  event: NostrEventRecord
): SellerListingSummary | null {
  if (event.kind !== 30402) {
    return null;
  }

  const title = getTagValues(event, "title")[0] ?? "Untitled listing";
  const status = getTagValues(event, "status")[0] ?? "active";
  const dTag = getTagValues(event, "d")[0];

  const priceTag = event.tags.find((tag) => tag[0] === "price");
  const price =
    priceTag &&
    typeof priceTag[1] === "string" &&
    !Number.isNaN(Number(priceTag[1]))
      ? Number(priceTag[1])
      : null;
  const currency =
    priceTag && typeof priceTag[2] === "string" ? priceTag[2] : null;

  const categories = getTagValues(event, "t").filter(
    (tag) => !RESERVED_MARKETPLACE_TAGS.has(tag)
  );
  const categoryFromKnownSet =
    categories.find((category) => CATEGORIES.includes(category)) ?? null;

  return {
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    title,
    status,
    price,
    currency,
    categories,
    primaryCategory: categoryFromKnownSet ?? categories[0] ?? null,
    dTag,
  };
}

export function selectSellerListingSummaries(
  events: NostrEventRecord[],
  pubkey: string
): SellerListingSummary[] {
  return events
    .filter((event) => event.pubkey === pubkey)
    .map(buildSellerListingSummary)
    .filter((listing): listing is SellerListingSummary => listing !== null)
    .sort((left, right) => right.createdAt - left.createdAt);
}
