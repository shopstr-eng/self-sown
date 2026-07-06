import { useState } from "react";
import { Input, Select, SelectItem, Textarea } from "@heroui/react";
import {
  StorefrontFooter,
  StorefrontSocialLink,
  StorefrontNavLink,
  StorefrontPolicies,
  StorefrontPolicy,
} from "@/utils/types/types";
import { POLICY_LABELS, getDefaultPolicies } from "@/utils/storefront-policies";

interface FooterEditorProps {
  footer: StorefrontFooter;
  onChange: (footer: StorefrontFooter) => void;
  shopName?: string;
}

const SOCIAL_PLATFORMS = [
  "instagram",
  "x",
  "facebook",
  "youtube",
  "tiktok",
  "telegram",
  "website",
  "email",
  "other",
] as const;

const PLATFORM_CONFIG: Record<
  string,
  { baseUrl: string; prefix?: string; placeholder: string; isFullUrl?: boolean }
> = {
  instagram: {
    baseUrl: "https://instagram.com/",
    placeholder: "yourfarm",
  },
  x: {
    baseUrl: "https://x.com/",
    placeholder: "yourfarm",
  },
  facebook: {
    baseUrl: "https://facebook.com/",
    placeholder: "yourfarm",
  },
  youtube: {
    baseUrl: "https://youtube.com/@",
    placeholder: "yourfarm",
  },
  tiktok: {
    baseUrl: "https://tiktok.com/",
    prefix: "@",
    placeholder: "yourfarm",
  },
  telegram: {
    baseUrl: "https://t.me/",
    placeholder: "yourfarm",
  },
  website: {
    baseUrl: "",
    placeholder: "https://yourfarm.com",
    isFullUrl: true,
  },
  email: {
    baseUrl: "mailto:",
    placeholder: "hello@yourfarm.com",
    isFullUrl: true,
  },
  other: {
    baseUrl: "",
    placeholder: "https://...",
    isFullUrl: true,
  },
};

function extractUsername(platform: string, url: string): string {
  const config = PLATFORM_CONFIG[platform];
  if (!config || config.isFullUrl) return url;
  if (config.baseUrl && url.startsWith(config.baseUrl)) {
    return url.slice(config.baseUrl.length);
  }
  const altBases = [
    `https://www.${platform}.com/`,
    `http://${platform}.com/`,
    `http://www.${platform}.com/`,
  ];
  if (platform === "x") {
    altBases.push("https://twitter.com/", "https://www.twitter.com/");
  }
  if (platform === "telegram") {
    altBases.push("https://telegram.me/");
  }
  for (const base of altBases) {
    if (url.startsWith(base)) {
      return url.slice(base.length);
    }
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  return url;
}

function buildFullUrl(platform: string, username: string): string {
  const config = PLATFORM_CONFIG[platform];
  if (!config || config.isFullUrl) return username;
  if (username.startsWith("http://") || username.startsWith("https://")) {
    return username;
  }
  let clean = username.replace(/^@+/, "");
  if (config.prefix) {
    clean = config.prefix + clean;
  }
  return config.baseUrl + clean;
}

const inputWrapperClass =
  "border-3 border-black rounded-lg bg-white shadow-none hover:bg-white data-[hover=true]:bg-white";

const selectClassNames = {
  trigger:
    "border-3 border-black rounded-lg bg-white shadow-none hover:bg-white data-[hover=true]:bg-white",
  value: "text-base !text-black",
  popoverContent: "border-2 border-black rounded-lg bg-white",
  listbox: "!text-black",
  label: "text-black",
};

const POLICY_KEYS: (keyof StorefrontPolicies)[] = [
  "returnPolicy",
  "termsOfService",
  "privacyPolicy",
  "cancellationPolicy",
];

export default function FooterEditor({
  footer,
  onChange,
  shopName,
}: FooterEditorProps) {
  const socialLinks = footer.socialLinks || [];
  const navLinks = footer.navLinks || [];
  const [expandedPolicy, setExpandedPolicy] = useState<string | null>(null);

  const policies = footer.policies || {};
  const defaults = getDefaultPolicies(shopName || "");

  const getPolicy = (key: keyof StorefrontPolicies): StorefrontPolicy => {
    return policies[key] || defaults[key]!;
  };

  const updatePolicy = (
    key: keyof StorefrontPolicies,
    updates: Partial<StorefrontPolicy>
  ) => {
    const current = getPolicy(key);
    onChange({
      ...footer,
      policies: {
        ...policies,
        [key]: { ...current, ...updates },
      },
    });
  };

  const resetPolicyToDefault = (key: keyof StorefrontPolicies) => {
    const defaultPolicy = defaults[key]!;
    onChange({
      ...footer,
      policies: {
        ...policies,
        [key]: { ...defaultPolicy },
      },
    });
  };

  const updateSocial = (idx: number, fields: Partial<StorefrontSocialLink>) => {
    const updated = [...socialLinks];
    updated[idx] = { ...updated[idx]!, ...fields };
    onChange({ ...footer, socialLinks: updated });
  };

  const addSocial = () => {
    onChange({
      ...footer,
      socialLinks: [...socialLinks, { platform: "instagram", url: "" }],
    });
  };

  const removeSocial = (idx: number) => {
    onChange({
      ...footer,
      socialLinks: socialLinks.filter((_, i) => i !== idx),
    });
  };

  const updateNav = (idx: number, fields: Partial<StorefrontNavLink>) => {
    const updated = [...navLinks];
    updated[idx] = { ...updated[idx]!, ...fields };
    onChange({ ...footer, navLinks: updated });
  };

  const addNav = () => {
    onChange({
      ...footer,
      navLinks: [...navLinks, { label: "", href: "" }],
    });
  };

  const removeNav = (idx: number) => {
    onChange({
      ...footer,
      navLinks: navLinks.filter((_, i) => i !== idx),
    });
  };

  const newsletter = footer.newsletter || {};
  const layout = footer.layout || {};

  const updateNewsletter = (
    fields: Partial<NonNullable<StorefrontFooter["newsletter"]>>
  ) => {
    onChange({ ...footer, newsletter: { ...newsletter, ...fields } });
  };

  const updateLayout = (
    fields: Partial<NonNullable<StorefrontFooter["layout"]>>
  ) => {
    onChange({ ...footer, layout: { ...layout, ...fields } });
  };

  return (
    <div className="space-y-6">
      <div>
        <Input
          label="Footer Text"
          classNames={{ inputWrapper: inputWrapperClass }}
          variant="bordered"
          value={footer.text || ""}
          onChange={(e) => onChange({ ...footer, text: e.target.value })}
          placeholder="e.g. Fresh from our farm to your table"
        />
      </div>

      <div>
        <label className="mb-2 block text-sm font-bold text-gray-700">
          Store Policies
        </label>
        <p className="mb-3 text-xs text-gray-500">
          These policies are shown as links in your storefront footer. Each
          opens its own page. Toggle them on or off, and edit the content to
          match your business.
        </p>
        <div className="space-y-2">
          {POLICY_KEYS.map((key) => {
            const policy = getPolicy(key);
            const isExpanded = expandedPolicy === key;
            return (
              <div
                key={key}
                className="rounded-lg border-2 border-gray-200 bg-gray-50"
              >
                <div className="flex items-center gap-3 p-3">
                  <input
                    type="checkbox"
                    checked={policy.enabled}
                    onChange={(e) =>
                      updatePolicy(key, { enabled: e.target.checked })
                    }
                    className="h-4 w-4"
                  />
                  <span className="flex-1 text-sm font-medium text-black">
                    {POLICY_LABELS[key]}
                  </span>
                  <button
                    type="button"
                    onClick={() => setExpandedPolicy(isExpanded ? null : key)}
                    className="text-xs font-bold text-blue-600 hover:underline"
                  >
                    {isExpanded ? "Collapse" : "Edit"}
                  </button>
                </div>
                {isExpanded && (
                  <div className="border-t border-gray-200 p-3">
                    <Textarea
                      classNames={{
                        inputWrapper: inputWrapperClass,
                        input: "text-sm",
                      }}
                      variant="bordered"
                      value={policy.content}
                      onChange={(e) =>
                        updatePolicy(key, { content: e.target.value })
                      }
                      minRows={10}
                      maxRows={30}
                      placeholder="Enter your policy content (Markdown supported)"
                    />
                    <div className="mt-2 flex items-center justify-between">
                      <p className="text-xs text-gray-400">
                        Supports Markdown formatting (headings, bold, lists)
                      </p>
                      <button
                        type="button"
                        onClick={() => resetPolicyToDefault(key)}
                        className="text-xs font-bold text-orange-600 hover:underline"
                      >
                        Reset to Default
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <label className="mb-2 block text-sm font-bold text-gray-700">
          Social Links
        </label>
        <div className="space-y-2">
          {socialLinks.map((link, idx) => {
            const config = PLATFORM_CONFIG[link.platform];
            const isFullUrl = config?.isFullUrl;
            const displayValue = isFullUrl
              ? link.url
              : extractUsername(link.platform, link.url);
            return (
              <div key={idx} className="flex items-center gap-2">
                <Select
                  classNames={{
                    ...selectClassNames,
                    trigger: selectClassNames.trigger + " w-36",
                  }}
                  variant="bordered"
                  selectedKeys={[link.platform]}
                  onChange={(e) => {
                    if (e.target.value) {
                      const newPlatform = e.target
                        .value as StorefrontSocialLink["platform"];
                      const currentUsername = extractUsername(
                        link.platform,
                        link.url
                      );
                      const newConfig = PLATFORM_CONFIG[newPlatform];
                      const newUrl = newConfig?.isFullUrl
                        ? ""
                        : buildFullUrl(newPlatform, currentUsername);
                      updateSocial(idx, {
                        platform: newPlatform,
                        url: newUrl,
                      });
                    }
                  }}
                  aria-label="Platform"
                  className="w-36"
                >
                  {SOCIAL_PLATFORMS.map((p) => (
                    <SelectItem key={p} className="text-black capitalize">
                      {p}
                    </SelectItem>
                  ))}
                </Select>
                <Input
                  classNames={{
                    inputWrapper: inputWrapperClass,
                    input: "!text-black",
                  }}
                  variant="bordered"
                  value={displayValue}
                  onChange={(e) => {
                    const val = e.target.value;
                    const fullUrl = isFullUrl
                      ? val
                      : buildFullUrl(link.platform, val);
                    updateSocial(idx, { url: fullUrl });
                  }}
                  placeholder={config?.placeholder || "https://..."}
                  className="flex-1"
                  startContent={
                    !isFullUrl && config?.baseUrl ? (
                      <span className="text-sm whitespace-nowrap text-gray-400">
                        {config.baseUrl}
                      </span>
                    ) : undefined
                  }
                />
                <button
                  type="button"
                  onClick={() => removeSocial(idx)}
                  className="text-xs text-red-500"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={addSocial}
          className="mt-2 text-sm font-bold text-blue-600 hover:underline"
        >
          + Add Social Link
        </button>
      </div>

      <div>
        <label className="mb-2 block text-sm font-bold text-gray-700">
          Footer Navigation Links
        </label>
        <div className="space-y-2">
          {navLinks.map((link, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <Input
                classNames={{ inputWrapper: inputWrapperClass }}
                variant="bordered"
                value={link.label}
                onChange={(e) => updateNav(idx, { label: e.target.value })}
                placeholder="Link label"
                className="w-40"
              />
              <Input
                classNames={{ inputWrapper: inputWrapperClass }}
                variant="bordered"
                value={link.href}
                onChange={(e) => updateNav(idx, { href: e.target.value })}
                placeholder="URL or page slug"
                className="flex-1"
              />
              <label className="flex items-center gap-1 text-xs whitespace-nowrap text-gray-500">
                <input
                  type="checkbox"
                  checked={link.isPage || false}
                  onChange={(e) => updateNav(idx, { isPage: e.target.checked })}
                />
                Page
              </label>
              <button
                type="button"
                onClick={() => removeNav(idx)}
                className="text-xs text-red-500"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addNav}
          className="mt-2 text-sm font-bold text-blue-600 hover:underline"
        >
          + Add Link
        </button>
      </div>

      <div>
        <label className="mb-2 block text-sm font-bold text-gray-700">
          Newsletter Signup
        </label>
        <p className="mb-3 text-xs text-gray-500">
          Show an email capture form in your footer. New subscribers are added
          to your email list.
        </p>
        <label className="mb-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={newsletter.enabled || false}
            onChange={(e) => updateNewsletter({ enabled: e.target.checked })}
          />
          Enable newsletter signup
        </label>
        {newsletter.enabled && (
          <div className="space-y-2">
            <Input
              label="Headline"
              classNames={{ inputWrapper: inputWrapperClass }}
              variant="bordered"
              value={newsletter.headline || ""}
              onChange={(e) => updateNewsletter({ headline: e.target.value })}
              placeholder="Join our newsletter"
            />
            <Input
              label="Subtext"
              classNames={{ inputWrapper: inputWrapperClass }}
              variant="bordered"
              value={newsletter.subtext || ""}
              onChange={(e) => updateNewsletter({ subtext: e.target.value })}
              placeholder="Get farm updates and special offers"
            />
            <div className="flex items-center gap-2">
              <Input
                label="Button Text"
                classNames={{ inputWrapper: inputWrapperClass }}
                variant="bordered"
                value={newsletter.buttonText || ""}
                onChange={(e) =>
                  updateNewsletter({ buttonText: e.target.value })
                }
                placeholder="Subscribe"
                className="flex-1"
              />
              <Input
                label="Email Placeholder"
                classNames={{ inputWrapper: inputWrapperClass }}
                variant="bordered"
                value={newsletter.placeholder || ""}
                onChange={(e) =>
                  updateNewsletter({ placeholder: e.target.value })
                }
                placeholder="you@example.com"
                className="flex-1"
              />
            </div>
            <Input
              label="Success Message"
              classNames={{ inputWrapper: inputWrapperClass }}
              variant="bordered"
              value={newsletter.successMessage || ""}
              onChange={(e) =>
                updateNewsletter({ successMessage: e.target.value })
              }
              placeholder="Thanks for subscribing!"
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={newsletter.collectPhone || false}
                onChange={(e) =>
                  updateNewsletter({ collectPhone: e.target.checked })
                }
              />
              Also collect a phone number
            </label>
          </div>
        )}
      </div>

      <div>
        <label className="mb-2 block text-sm font-bold text-gray-700">
          Footer Layout
        </label>
        <p className="mb-3 text-xs text-gray-500">
          Control how your footer content is aligned and arranged, just like
          your navigation bar.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Select
            label="Alignment"
            classNames={selectClassNames}
            variant="bordered"
            selectedKeys={[layout.alignment || "left"]}
            onChange={(e) => {
              if (e.target.value)
                updateLayout({
                  alignment: e.target.value as NonNullable<
                    StorefrontFooter["layout"]
                  >["alignment"],
                });
            }}
            aria-label="Footer alignment"
          >
            <SelectItem key="left" className="text-black">
              Left
            </SelectItem>
            <SelectItem key="center" className="text-black">
              Center
            </SelectItem>
            <SelectItem key="right" className="text-black">
              Right
            </SelectItem>
          </Select>
          <Select
            label="Link Spacing"
            classNames={selectClassNames}
            variant="bordered"
            selectedKeys={[layout.linkSpacing || "normal"]}
            onChange={(e) => {
              if (e.target.value)
                updateLayout({
                  linkSpacing: e.target.value as NonNullable<
                    StorefrontFooter["layout"]
                  >["linkSpacing"],
                });
            }}
            aria-label="Footer link spacing"
          >
            <SelectItem key="compact" className="text-black">
              Compact
            </SelectItem>
            <SelectItem key="normal" className="text-black">
              Normal
            </SelectItem>
            <SelectItem key="spacious" className="text-black">
              Spacious
            </SelectItem>
          </Select>
          <Select
            label="Column Layout"
            classNames={selectClassNames}
            variant="bordered"
            selectedKeys={[layout.columnLayout || "spread"]}
            onChange={(e) => {
              if (e.target.value)
                updateLayout({
                  columnLayout: e.target.value as NonNullable<
                    StorefrontFooter["layout"]
                  >["columnLayout"],
                });
            }}
            aria-label="Footer column layout"
          >
            <SelectItem key="spread" className="text-black">
              Spread (multi-column)
            </SelectItem>
            <SelectItem key="stacked" className="text-black">
              Stacked (single centered column)
            </SelectItem>
          </Select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={footer.showPoweredBy !== false}
          onChange={(e) =>
            onChange({ ...footer, showPoweredBy: e.target.checked })
          }
        />
        Show &quot;Powered by Milk Market&quot;
      </label>
    </div>
  );
}
