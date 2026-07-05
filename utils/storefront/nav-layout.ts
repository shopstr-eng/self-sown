import type { StorefrontNavLayout } from "@/utils/types/types";

// Pure, dependency-free resolver that turns the optional StorefrontNavLayout
// config into concrete render decisions + Tailwind class fragments. Kept pure so
// the live storefront (storefront-layout.tsx) and the settings preview
// (storefront-preview-panel.tsx) render identical layouts from one source.
//
// IMPORTANT: an absent/empty navLayout must resolve to the historical default
// (logo left, single row, links gap-1, no extra justify) so already-published
// storefront events keep rendering byte-for-byte the same.

export interface ResolvedNavLayout {
  mode: "inline" | "stacked";
  logoPosition: "left" | "center" | "above" | "below";
  // For stacked mode: which of the two rows holds each cluster.
  logoRow: "top" | "bottom";
  linksRow: "top" | "bottom";
  utilityRow: "top" | "bottom";
  // Justify class for the nav-links cluster ("" = no explicit justify; used so
  // the default logo-left layout stays render-identical).
  linkJustifyClass: string;
  // Gap class between individual nav links (defaults to today's gap-1).
  linkGapClass: string;
}

export function resolveNavLayout(
  navLayout?: StorefrontNavLayout
): ResolvedNavLayout {
  const logoPosition = navLayout?.logoPosition ?? "left";
  const stacked = logoPosition === "above" || logoPosition === "below";

  const logoRow: "top" | "bottom" = logoPosition === "below" ? "bottom" : "top";
  const linksRow: "top" | "bottom" = logoRow === "top" ? "bottom" : "top";
  // Utility cluster (cart + profile/sign-in) is always right-justified; when the
  // logo is stacked the seller can move it to the top or bottom row. Default =
  // the logo's row.
  const utilityRow: "top" | "bottom" =
    navLayout?.utilityPosition === "top"
      ? "top"
      : navLayout?.utilityPosition === "bottom"
        ? "bottom"
        : logoRow;

  const linkJustifyClass =
    navLayout?.linkAlignment === "left"
      ? "justify-start"
      : navLayout?.linkAlignment === "center"
        ? "justify-center"
        : navLayout?.linkAlignment === "right"
          ? "justify-end"
          : "";

  const linkGapClass =
    navLayout?.linkSpacing === "compact"
      ? "gap-0.5"
      : navLayout?.linkSpacing === "spacious"
        ? "gap-4"
        : "gap-1";

  return {
    mode: stacked ? "stacked" : "inline",
    logoPosition,
    logoRow,
    linksRow,
    utilityRow,
    linkJustifyClass,
    linkGapClass,
  };
}
