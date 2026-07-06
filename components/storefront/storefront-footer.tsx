import {
  StorefrontColorScheme,
  StorefrontFooter,
  StorefrontFooterColors,
  StorefrontPolicies,
} from "@/utils/types/types";
import Link from "next/link";
import FormattedText from "./formatted-text";
import {
  POLICY_LABELS,
  POLICY_SLUGS,
  getDefaultPolicies,
} from "@/utils/storefront-policies";
import {
  isExternalStorefrontHref,
  sanitizeStorefrontNavHref,
  sanitizeStorefrontSocialLink,
} from "@/utils/storefront-links";
import {
  applyCustomDomainHref,
  useIsCustomDomain,
} from "@/utils/storefront/custom-domain-context";
import StorefrontFooterNewsletter from "./storefront-footer-newsletter";

interface StorefrontFooterProps {
  footer: StorefrontFooter;
  colors: StorefrontColorScheme;
  footerColors?: StorefrontFooterColors;
  shopName: string;
  shopSlug: string;
  shopPubkey?: string;
  isPreview?: boolean;
}

const SOCIAL_IMAGE_ICONS: Record<string, string> = {
  instagram: "/instagram-icon.png",
  x: "/x-logo-black.png",
  youtube: "/youtube-icon.png",
  tiktok: "/tiktok-icon.png",
  telegram: "/telegram-icon.png",
  facebook: "/facebook-icon.png",
};

const SOCIAL_EMOJI_ICONS: Record<string, string> = {
  website: "🌐",
  email: "✉",
  other: "🔗",
};

const POLICY_KEYS: (keyof StorefrontPolicies)[] = [
  "returnPolicy",
  "termsOfService",
  "privacyPolicy",
  "cancellationPolicy",
];

export default function StorefrontFooterComponent({
  footer,
  colors,
  footerColors,
  shopName,
  shopSlug,
  shopPubkey,
  isPreview,
}: StorefrontFooterProps) {
  const isCustomDomain = useIsCustomDomain();
  const socialLinks = footer.socialLinks || [];
  const navLinks = footer.navLinks || [];
  const showPoweredBy = footer.showPoweredBy !== false;

  const bg = footerColors?.background || colors.secondary;
  const text = footerColors?.text || colors.background;
  const accent = footerColors?.accent || colors.primary;

  const policies = footer.policies || {};
  const defaults = getDefaultPolicies(shopName);

  const enabledPolicies = POLICY_KEYS.filter((key) => {
    const policy = policies[key] || defaults[key];
    return policy && policy.enabled;
  });

  // Footer layout controls, mirroring the top-nav's navLayout. All optional; an
  // absent field preserves the historical render (centered mobile, spread
  // desktop row) so previously published storefronts stay pixel-stable.
  const layout = footer.layout || {};
  const newsletter = footer.newsletter || {};
  const alignment = layout.alignment;
  const columnLayout = layout.columnLayout || "spread";
  const linkSpacing = layout.linkSpacing || "normal";

  const alignItemsClass =
    alignment === "left"
      ? "items-start"
      : alignment === "right"
        ? "items-end"
        : "items-center";
  const rowClass =
    columnLayout === "stacked"
      ? `flex flex-col ${alignItemsClass} gap-8`
      : `flex flex-col ${alignItemsClass} gap-8 md:flex-row md:items-start md:justify-between`;
  const brandTextClass = alignment
    ? alignment === "left"
      ? "text-left"
      : alignment === "right"
        ? "text-right"
        : "text-center"
    : columnLayout === "stacked"
      ? "text-center"
      : "text-center md:text-left";
  const linkSpacingClass =
    linkSpacing === "compact"
      ? "gap-x-4 gap-y-2"
      : linkSpacing === "spacious"
        ? "gap-x-10 gap-y-3"
        : "gap-x-6 gap-y-2";
  const newsletterJustify =
    alignment === "left"
      ? "justify-start"
      : alignment === "right"
        ? "justify-end"
        : "justify-center";

  return (
    <footer
      className="border-t px-4 py-12 md:px-6"
      style={{
        backgroundColor: bg,
        borderColor: accent + "22",
        color: text,
      }}
    >
      <div className="mx-auto max-w-6xl">
        {newsletter.enabled && (
          <div
            className={`mb-8 flex ${newsletterJustify} border-b pb-8`}
            style={{ borderColor: text + "11" }}
          >
            <StorefrontFooterNewsletter
              config={newsletter}
              shopPubkey={shopPubkey}
              isPreview={isPreview}
              textColor={text}
              accentColor={accent}
              bgColor={bg}
              align={alignment || "center"}
            />
          </div>
        )}
        <div className={rowClass}>
          <div className={brandTextClass}>
            <FormattedText
              as="h3"
              className="font-heading text-lg font-bold"
              text={shopName}
            />
            {footer.text && (
              <FormattedText
                as="p"
                className="font-body mt-2 max-w-sm text-sm opacity-60"
                text={footer.text}
              />
            )}
          </div>

          {navLinks.length > 0 && (
            <div
              className={`flex flex-wrap justify-center ${linkSpacingClass}`}
            >
              {navLinks.map((link, idx) => {
                const href = applyCustomDomainHref(
                  sanitizeStorefrontNavHref(link, shopSlug),
                  shopSlug,
                  isCustomDomain
                );

                if (isExternalStorefrontHref(href)) {
                  return (
                    <a
                      key={idx}
                      href={href}
                      target={href.startsWith("http") ? "_blank" : undefined}
                      rel={
                        href.startsWith("http")
                          ? "noopener noreferrer"
                          : undefined
                      }
                      className="font-body text-sm opacity-60 transition-opacity hover:opacity-100"
                      style={{ color: text }}
                    >
                      {link.label}
                    </a>
                  );
                }

                return (
                  <Link
                    key={idx}
                    href={href}
                    className="font-body text-sm opacity-60 transition-opacity hover:opacity-100"
                    style={{ color: text }}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </div>
          )}

          {socialLinks.length > 0 && (
            <div className="flex gap-4">
              {socialLinks.map((social, idx) => {
                const href = sanitizeStorefrontSocialLink(social.url);

                return (
                  <a
                    key={idx}
                    href={href}
                    target={href.startsWith("http") ? "_blank" : undefined}
                    rel={
                      href.startsWith("http")
                        ? "noopener noreferrer"
                        : undefined
                    }
                    className="flex h-10 w-10 items-center justify-center rounded-full text-lg transition-transform hover:scale-110"
                    style={{
                      backgroundColor: accent + "22",
                      color: accent,
                    }}
                    title={social.label || social.platform}
                  >
                    {SOCIAL_IMAGE_ICONS[social.platform] ? (
                      <img
                        src={SOCIAL_IMAGE_ICONS[social.platform]}
                        alt={social.label || social.platform}
                        className="h-5 w-5 object-contain"
                      />
                    ) : (
                      SOCIAL_EMOJI_ICONS[social.platform] ||
                      SOCIAL_EMOJI_ICONS.other
                    )}
                  </a>
                );
              })}
            </div>
          )}
        </div>

        {enabledPolicies.length > 0 && (
          <div
            className="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 border-t pt-6"
            style={{ borderColor: text + "11" }}
          >
            {enabledPolicies.map((key) => (
              <Link
                key={key}
                href={applyCustomDomainHref(
                  `/stall/${shopSlug}/${POLICY_SLUGS[key]}`,
                  shopSlug,
                  isCustomDomain
                )}
                className="font-body text-xs opacity-40 transition-opacity hover:opacity-80"
                style={{ color: text }}
              >
                {POLICY_LABELS[key]}
              </Link>
            ))}
          </div>
        )}

        {showPoweredBy && (
          <div
            className={`${
              enabledPolicies.length > 0 ? "mt-4" : "mt-8 border-t pt-6"
            } text-center text-sm opacity-40`}
            style={
              enabledPolicies.length > 0 ? {} : { borderColor: text + "11" }
            }
          >
            Powered by{" "}
            <Link href="/" className="underline" style={{ color: accent }}>
              Milk Market
            </Link>
          </div>
        )}
      </div>
    </footer>
  );
}
