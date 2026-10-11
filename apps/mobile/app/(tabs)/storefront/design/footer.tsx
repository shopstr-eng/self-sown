import { View } from "react-native";

import type {
  StorefrontPolicies,
  StorefrontPolicy,
  StorefrontSocialLink,
} from "@self-sown/domain";

type SocialPlatform = StorefrontSocialLink["platform"];

import {
  AddItemButton,
  ColorField,
  DesignSectionTitle,
  DesignTextField,
  ListItemChrome,
  OptionChips,
  ToggleRow,
} from "@/components/design-controls";
import { DesignScreen } from "@/components/design-screen";
import { SellerCard } from "@/components/seller-ui";
import { moveItem } from "@/lib/storefront-design-scopes";
import { useStorefrontDesignStore } from "@/lib/storefront-design-store";

const SOCIAL_PLATFORMS: { value: SocialPlatform; label: string }[] = [
  { value: "instagram", label: "Instagram" },
  { value: "x", label: "X" },
  { value: "facebook", label: "Facebook" },
  { value: "youtube", label: "YouTube" },
  { value: "tiktok", label: "TikTok" },
  { value: "telegram", label: "Telegram" },
  { value: "website", label: "Website" },
  { value: "email", label: "Email" },
  { value: "other", label: "Other" },
];

const POLICY_KEYS: { key: keyof StorefrontPolicies; label: string }[] = [
  { key: "returnPolicy", label: "Return & refund policy" },
  { key: "termsOfService", label: "Terms of service" },
  { key: "privacyPolicy", label: "Privacy policy" },
  { key: "cancellationPolicy", label: "Cancellation policy" },
];

export default function FooterEditorScreen() {
  const draft = useStorefrontDesignStore((state) => state.draft);
  const update = useStorefrontDesignStore((state) => state.update);

  const footer = draft.footer ?? {};
  const footerColors = draft.footerColors;
  const newsletter = footer.newsletter ?? {};
  const socialLinks = footer.socialLinks ?? [];
  const navLinks = footer.navLinks ?? [];

  const patchFooter = (patch: Partial<typeof footer>) => {
    update((current) => ({
      ...current,
      footer: { ...(current.footer ?? {}), ...patch },
    }));
  };

  const patchFooterColors = (
    key: "background" | "text" | "accent",
    value: string | undefined
  ) => {
    update((current) => {
      const existing = current.footerColors ?? {
        background: "#1a1a1a",
        text: "#f5f1e6",
        accent: "#d4a017",
      };
      return {
        ...current,
        footerColors: { ...existing, [key]: value ?? existing[key] },
      };
    });
  };

  return (
    <DesignScreen
      title="Footer"
      description="The strip at the bottom of every storefront page."
    >
      <SellerCard>
        <DesignSectionTitle title="Basics" />
        <DesignTextField
          label="Footer text"
          value={footer.text}
          multiline
          placeholder="Grown with care in the Willamette Valley."
          onChange={(value) => patchFooter({ text: value })}
        />
        <ToggleRow
          label="Show “Powered by” badge"
          value={footer.showPoweredBy !== false}
          onChange={(value) => patchFooter({ showPoweredBy: value })}
        />
        <ToggleRow
          label="Show my Nostr address"
          description="Displays your verified name@domain on a custom domain, so buyers can zap or follow you."
          value={footer.showNip05 === true}
          onChange={(value) => patchFooter({ showNip05: value })}
        />
      </SellerCard>

      <SellerCard>
        <DesignSectionTitle title="Social links" />
        {socialLinks.map((link, index) => (
          <ListItemChrome
            key={index}
            title={link.label || link.platform}
            subtitle={link.url}
            isFirst={index === 0}
            isLast={index === socialLinks.length - 1}
            onMoveUp={() =>
              patchFooter({ socialLinks: moveItem(socialLinks, index, -1) })
            }
            onMoveDown={() =>
              patchFooter({ socialLinks: moveItem(socialLinks, index, 1) })
            }
            onDelete={() =>
              patchFooter({
                socialLinks: socialLinks.filter((_entry, i) => i !== index),
              })
            }
          >
            <OptionChips
              label="Platform"
              value={link.platform}
              allowUnset={false}
              options={SOCIAL_PLATFORMS}
              onChange={(value) =>
                patchFooter({
                  socialLinks: socialLinks.map((entry, i) =>
                    i === index
                      ? { ...entry, platform: value ?? "other" }
                      : entry
                  ),
                })
              }
            />
            <DesignTextField
              label="URL"
              value={link.url}
              keyboardType="url"
              onChange={(value) =>
                patchFooter({
                  socialLinks: socialLinks.map((entry, i) =>
                    i === index ? { ...entry, url: value ?? "" } : entry
                  ),
                })
              }
            />
            <DesignTextField
              label="Label (optional)"
              value={link.label}
              onChange={(value) =>
                patchFooter({
                  socialLinks: socialLinks.map((entry, i) =>
                    i === index ? { ...entry, label: value } : entry
                  ),
                })
              }
            />
          </ListItemChrome>
        ))}
        <AddItemButton
          label="Add social link"
          onPress={() =>
            patchFooter({
              socialLinks: [...socialLinks, { platform: "instagram", url: "" }],
            })
          }
        />
      </SellerCard>

      <SellerCard>
        <DesignSectionTitle
          title="Footer links"
          description="Extra links shown in the footer — e.g. custom pages or external sites."
        />
        {navLinks.map((link, index) => (
          <ListItemChrome
            key={index}
            title={link.label || `Link ${index + 1}`}
            subtitle={link.href}
            isFirst={index === 0}
            isLast={index === navLinks.length - 1}
            onMoveUp={() =>
              patchFooter({ navLinks: moveItem(navLinks, index, -1) })
            }
            onMoveDown={() =>
              patchFooter({ navLinks: moveItem(navLinks, index, 1) })
            }
            onDelete={() =>
              patchFooter({
                navLinks: navLinks.filter((_entry, i) => i !== index),
              })
            }
          >
            <DesignTextField
              label="Label"
              value={link.label}
              onChange={(value) =>
                patchFooter({
                  navLinks: navLinks.map((entry, i) =>
                    i === index ? { ...entry, label: value ?? "" } : entry
                  ),
                })
              }
            />
            <DesignTextField
              label="Link (https://… or page slug)"
              value={link.href}
              keyboardType="url"
              onChange={(value) =>
                patchFooter({
                  navLinks: navLinks.map((entry, i) =>
                    i === index ? { ...entry, href: value ?? "" } : entry
                  ),
                })
              }
            />
            <ToggleRow
              label="This is one of my custom pages"
              value={link.isPage === true}
              onChange={(value) =>
                patchFooter({
                  navLinks: navLinks.map((entry, i) =>
                    i === index
                      ? { ...entry, isPage: value ? true : undefined }
                      : entry
                  ),
                })
              }
            />
          </ListItemChrome>
        ))}
        <AddItemButton
          label="Add footer link"
          onPress={() =>
            patchFooter({ navLinks: [...navLinks, { label: "", href: "" }] })
          }
        />
      </SellerCard>

      <SellerCard>
        <DesignSectionTitle
          title="Policies"
          description="Enabled policies get their own page, linked from the footer."
        />
        {POLICY_KEYS.map(({ key, label }) => {
          const policy: StorefrontPolicy | undefined = footer.policies?.[key];
          return (
            <View key={key} style={{ marginBottom: 12 }}>
              <ToggleRow
                label={label}
                value={policy?.enabled === true}
                onChange={(value) =>
                  patchFooter({
                    policies: {
                      ...(footer.policies ?? {}),
                      [key]: {
                        enabled: value,
                        content: policy?.content ?? "",
                      },
                    },
                  })
                }
              />
              {policy?.enabled ? (
                <DesignTextField
                  label={`${label} text`}
                  value={policy.content}
                  multiline
                  onChange={(value) =>
                    patchFooter({
                      policies: {
                        ...(footer.policies ?? {}),
                        [key]: { enabled: true, content: value ?? "" },
                      },
                    })
                  }
                />
              ) : null}
            </View>
          );
        })}
      </SellerCard>

      <SellerCard>
        <DesignSectionTitle
          title="Newsletter signup"
          description="Collects visitor emails into your list and starts the welcome series."
        />
        <ToggleRow
          label="Show newsletter signup"
          value={newsletter.enabled === true}
          onChange={(value) =>
            patchFooter({ newsletter: { ...newsletter, enabled: value } })
          }
        />
        {newsletter.enabled ? (
          <View>
            <DesignTextField
              label="Headline"
              value={newsletter.headline}
              onChange={(value) =>
                patchFooter({ newsletter: { ...newsletter, headline: value } })
              }
            />
            <DesignTextField
              label="Subtext"
              value={newsletter.subtext}
              multiline
              onChange={(value) =>
                patchFooter({ newsletter: { ...newsletter, subtext: value } })
              }
            />
            <DesignTextField
              label="Button text"
              value={newsletter.buttonText}
              onChange={(value) =>
                patchFooter({
                  newsletter: { ...newsletter, buttonText: value },
                })
              }
            />
            <DesignTextField
              label="Input placeholder"
              value={newsletter.placeholder}
              onChange={(value) =>
                patchFooter({
                  newsletter: { ...newsletter, placeholder: value },
                })
              }
            />
            <DesignTextField
              label="Success message"
              value={newsletter.successMessage}
              onChange={(value) =>
                patchFooter({
                  newsletter: { ...newsletter, successMessage: value },
                })
              }
            />
            <ToggleRow
              label="Also ask for phone number"
              value={newsletter.collectPhone === true}
              onChange={(value) =>
                patchFooter({
                  newsletter: { ...newsletter, collectPhone: value },
                })
              }
            />
          </View>
        ) : null}
      </SellerCard>

      <SellerCard>
        <DesignSectionTitle title="Layout & colors" />
        <OptionChips
          label="Content alignment"
          value={footer.layout?.alignment}
          options={[
            { value: "left", label: "Left" },
            { value: "center", label: "Center" },
            { value: "right", label: "Right" },
          ]}
          onChange={(value) =>
            patchFooter({
              layout: { ...(footer.layout ?? {}), alignment: value },
            })
          }
        />
        <OptionChips
          label="Link spacing"
          value={footer.layout?.linkSpacing}
          options={[
            { value: "compact", label: "Compact" },
            { value: "normal", label: "Normal" },
            { value: "spacious", label: "Spacious" },
          ]}
          onChange={(value) =>
            patchFooter({
              layout: { ...(footer.layout ?? {}), linkSpacing: value },
            })
          }
        />
        <OptionChips
          label="Column layout"
          value={footer.layout?.columnLayout}
          options={[
            { value: "spread", label: "Spread" },
            { value: "stacked", label: "Stacked" },
          ]}
          onChange={(value) =>
            patchFooter({
              layout: { ...(footer.layout ?? {}), columnLayout: value },
            })
          }
        />
        <ColorField
          label="Footer background"
          value={footerColors?.background}
          allowEmpty={false}
          onChange={(value) => patchFooterColors("background", value)}
        />
        <ColorField
          label="Footer text"
          value={footerColors?.text}
          allowEmpty={false}
          onChange={(value) => patchFooterColors("text", value)}
        />
        <ColorField
          label="Footer accent"
          value={footerColors?.accent}
          allowEmpty={false}
          onChange={(value) => patchFooterColors("accent", value)}
        />
        {footerColors ? (
          <ToggleRow
            label="Use theme defaults"
            description="Remove the custom footer colors."
            value={false}
            onChange={() =>
              update((current) => {
                const next = { ...current };
                delete next.footerColors;
                return next;
              })
            }
          />
        ) : null}
      </SellerCard>
    </DesignScreen>
  );
}
