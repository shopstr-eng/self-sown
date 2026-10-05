import { useEffect, useState } from "react";
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
  resolveStorefrontPolicy,
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
import { joinClassNames } from "./sections/section-elements";

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
  const showNip05 = footer.showNip05 === true;

  // Buyer-visible Nostr address (NIP-05). Resolved from this host's own
  // /.well-known/nostr.json — the exact file Nostr clients verify against, so
  // the displayed address can never drift from what actually resolves. On the
  // platform host that file names the platform's own accounts; matching the
  // entry against shopPubkey means the address only renders where the
  // well-known file genuinely points at this seller (their verified custom
  // domain or self-host instance). Silent empty-state on any failure: the
  // footer simply omits the line.
  const [nip05Address, setNip05Address] = useState<string | null>(null);
  const [nip05Copied, setNip05Copied] = useState(false);
  useEffect(() => {
    if (!showNip05 || !shopPubkey || isPreview) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/.well-known/nostr.json");
        if (!r.ok) return;
        const data = (await r.json()) as { names?: Record<string, string> };
        const names = data?.names ?? {};
        // The endpoint inserts the exact username before its lower-cased
        // alias, so the first matching key is the canonical display form.
        const name = Object.keys(names).find(
          (k) => names[k]?.toLowerCase() === shopPubkey.toLowerCase()
        );
        if (cancelled || !name) return;
        const host = window.location.hostname.toLowerCase().trim();
        if (host) setNip05Address(`${name}@${host}`);
      } catch {
        // No address line on fetch/parse failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showNip05, shopPubkey, isPreview]);

  const bg = footerColors?.background || colors.secondary;
  const text = footerColors?.text || colors.background;
  const accent = footerColors?.accent || colors.primary;

  const policies = footer.policies || {};

  // Shared resolver — same semantics as the policy page renderer and the SSR
  // subpage validator (stored wins when present + enabled, else default).
  const enabledPolicies = POLICY_KEYS.filter((key) =>
    resolveStorefrontPolicy(policies, key, shopName)
  );

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
            {/* Brand wordmark is not a section heading; keep it out of the
                heading outline so sparse stalls don't skip h1 -> h3. */}
            <FormattedText
              as="p"
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
            {nip05Address && (
              <div
                className={`mt-3 flex flex-wrap items-center gap-2 ${
                  alignment === "left"
                    ? "justify-start"
                    : alignment === "right"
                      ? "justify-end"
                      : "justify-center md:justify-start"
                }`}
              >
                <span
                  className="font-body text-xs opacity-60"
                  style={{ color: text }}
                  title="Verify this shop in any Nostr client"
                >
                  ⚡ {nip05Address}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(nip05Address)
                      .then(() => {
                        setNip05Copied(true);
                        setTimeout(() => setNip05Copied(false), 2000);
                      })
                      .catch(() => {
                        // Clipboard unavailable (permissions) — the address
                        // text itself is still visible/selectable.
                      });
                  }}
                  className="font-body text-xs underline opacity-60 transition-opacity hover:opacity-100"
                  style={{ color: accent }}
                >
                  {nip05Copied ? "Copied!" : "Copy"}
                </button>
              </div>
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
            className={joinClassNames(
              enabledPolicies.length > 0 ? "mt-4" : "mt-8 border-t pt-6",
              "text-center text-sm opacity-40"
            )}
            style={
              enabledPolicies.length > 0 ? {} : { borderColor: text + "11" }
            }
          >
            Powered by{" "}
            <Link href="/" className="underline" style={{ color: accent }}>
              Self-sown
            </Link>
          </div>
        )}
      </div>
    </footer>
  );
}
