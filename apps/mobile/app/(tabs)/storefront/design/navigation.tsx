import { View } from "react-native";

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

// Nav bar colors/layout/links plus the toggles that expose optional
// storefront pages (community, wallet, blog) and hide the built-in Shop link.
export default function NavigationEditorScreen() {
  const draft = useStorefrontDesignStore((state) => state.draft);
  const update = useStorefrontDesignStore((state) => state.update);

  const navColors = draft.navColors;
  const navLayout = draft.navLayout ?? {};
  const navLinks = draft.navLinks ?? [];

  const patchNavColors = (
    key: "background" | "text" | "accent",
    value: string | undefined
  ) => {
    update((current) => {
      const existing = current.navColors ?? {
        background: "#ffffff",
        text: "#1a1a1a",
        accent: "#2f4a2c",
      };
      const next = { ...existing, [key]: value ?? existing[key] };
      // All three are required by the parser; never write a partial set.
      return { ...current, navColors: next };
    });
  };

  return (
    <DesignScreen
      title="Navigation"
      description="The bar across the top of your storefront."
    >
      <SellerCard>
        <DesignSectionTitle
          title="Nav colors"
          description="Defaults shown are the starting point — adjust all three to taste."
        />
        <ColorField
          label="Nav background"
          value={navColors?.background}
          allowEmpty={false}
          onChange={(value) => patchNavColors("background", value)}
        />
        <ColorField
          label="Nav text"
          value={navColors?.text}
          allowEmpty={false}
          onChange={(value) => patchNavColors("text", value)}
        />
        <ColorField
          label="Nav accent"
          value={navColors?.accent}
          allowEmpty={false}
          onChange={(value) => patchNavColors("accent", value)}
        />
        {navColors ? (
          <ToggleRow
            label="Use theme defaults"
            description="Remove the custom nav colors."
            value={false}
            onChange={() =>
              update((current) => {
                const next = { ...current };
                delete next.navColors;
                return next;
              })
            }
          />
        ) : null}
      </SellerCard>

      <SellerCard>
        <DesignSectionTitle title="Nav layout" />
        <OptionChips
          label="Logo position"
          value={navLayout.logoPosition}
          options={[
            { value: "left", label: "Left" },
            { value: "center", label: "Center" },
            { value: "above", label: "Above links" },
            { value: "below", label: "Below links" },
          ]}
          onChange={(value) =>
            update((current) => ({
              ...current,
              navLayout: { ...navLayout, logoPosition: value },
            }))
          }
        />
        <OptionChips
          label="Link alignment"
          value={navLayout.linkAlignment}
          options={[
            { value: "left", label: "Left" },
            { value: "center", label: "Center" },
            { value: "right", label: "Right" },
          ]}
          onChange={(value) =>
            update((current) => ({
              ...current,
              navLayout: { ...navLayout, linkAlignment: value },
            }))
          }
        />
        <OptionChips
          label="Link spacing"
          value={navLayout.linkSpacing}
          options={[
            { value: "compact", label: "Compact" },
            { value: "normal", label: "Normal" },
            { value: "spacious", label: "Spacious" },
          ]}
          onChange={(value) =>
            update((current) => ({
              ...current,
              navLayout: { ...navLayout, linkSpacing: value },
            }))
          }
        />
        <OptionChips
          label="Cart & profile row"
          value={navLayout.utilityPosition}
          options={[
            { value: "top", label: "Top row" },
            { value: "bottom", label: "Bottom row" },
          ]}
          onChange={(value) =>
            update((current) => ({
              ...current,
              navLayout: { ...navLayout, utilityPosition: value },
            }))
          }
        />
        <ToggleRow
          label="Transparent over hero"
          description="The nav blends into a leading hero and solidifies on scroll."
          value={navLayout.transparent === true}
          onChange={(value) =>
            update((current) => ({
              ...current,
              navLayout: {
                ...navLayout,
                transparent: value ? true : undefined,
              },
            }))
          }
        />
        <ToggleRow
          label="Hide on scroll down"
          value={navLayout.hideOnScroll === true}
          onChange={(value) =>
            update((current) => ({
              ...current,
              navLayout: {
                ...navLayout,
                hideOnScroll: value ? true : undefined,
              },
            }))
          }
        />
      </SellerCard>

      <SellerCard>
        <DesignSectionTitle
          title="Nav links"
          description="Custom links in the nav bar. “Page” links point at your custom pages."
        />
        {navLinks.map((link, index) => (
          <ListItemChrome
            key={index}
            title={link.label || `Link ${index + 1}`}
            subtitle={link.href}
            isFirst={index === 0}
            isLast={index === navLinks.length - 1}
            onMoveUp={() =>
              update((current) => ({
                ...current,
                navLinks: moveItem(navLinks, index, -1),
              }))
            }
            onMoveDown={() =>
              update((current) => ({
                ...current,
                navLinks: moveItem(navLinks, index, 1),
              }))
            }
            onDelete={() =>
              update((current) => ({
                ...current,
                navLinks: navLinks.filter((_entry, i) => i !== index),
              }))
            }
          >
            <DesignTextField
              label="Label"
              value={link.label}
              onChange={(value) =>
                update((current) => ({
                  ...current,
                  navLinks: navLinks.map((entry, i) =>
                    i === index ? { ...entry, label: value ?? "" } : entry
                  ),
                }))
              }
            />
            <DesignTextField
              label="Link (https://… or page slug)"
              value={link.href}
              keyboardType="url"
              onChange={(value) =>
                update((current) => ({
                  ...current,
                  navLinks: navLinks.map((entry, i) =>
                    i === index ? { ...entry, href: value ?? "" } : entry
                  ),
                }))
              }
            />
            <ToggleRow
              label="This is one of my custom pages"
              value={link.isPage === true}
              onChange={(value) =>
                update((current) => ({
                  ...current,
                  navLinks: navLinks.map((entry, i) =>
                    i === index
                      ? { ...entry, isPage: value ? true : undefined }
                      : entry
                  ),
                }))
              }
            />
          </ListItemChrome>
        ))}
        <AddItemButton
          label="Add nav link"
          onPress={() =>
            update((current) => ({
              ...current,
              navLinks: [...navLinks, { label: "", href: "" }],
            }))
          }
        />
      </SellerCard>

      <SellerCard>
        <DesignSectionTitle title="Built-in links & pages" />
        <ToggleRow
          label="Hide the Shop link"
          description="Removes the built-in link to your product listing."
          value={draft.hideShopLink === true}
          onChange={(value) =>
            update((current) => ({
              ...current,
              hideShopLink: value ? true : undefined,
            }))
          }
        />
        <ToggleRow
          label="Show Community page"
          value={draft.showCommunityPage === true}
          onChange={(value) =>
            update((current) => ({ ...current, showCommunityPage: value }))
          }
        />
        <ToggleRow
          label="Show Wallet page"
          value={draft.showWalletPage === true}
          onChange={(value) =>
            update((current) => ({ ...current, showWalletPage: value }))
          }
        />
        <ToggleRow
          label="Show Blog page"
          value={draft.showBlogPage === true}
          onChange={(value) =>
            update((current) => ({ ...current, showBlogPage: value }))
          }
        />
      </SellerCard>

      <SellerCard>
        <DesignSectionTitle
          title="Shopping assistant"
          description="The AI assistant on your storefront. On for everyone unless you turn it off — matches the web settings."
        />
        <ToggleRow
          label="Show assistant to buyers"
          value={draft.assistantVisibility?.buyers !== false}
          onChange={(value) =>
            update((current) => ({
              ...current,
              assistantVisibility: {
                ...current.assistantVisibility,
                // Only ever persisted as false; undefined = default (shown),
                // same convention as the web form's toggles.
                buyers: value ? undefined : false,
              },
            }))
          }
        />
        <ToggleRow
          label="Show assistant on your seller pages"
          value={draft.assistantVisibility?.seller !== false}
          onChange={(value) =>
            update((current) => ({
              ...current,
              assistantVisibility: {
                ...current.assistantVisibility,
                seller: value ? undefined : false,
              },
            }))
          }
        />
      </SellerCard>
      <View />
    </DesignScreen>
  );
}
