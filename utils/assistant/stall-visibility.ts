// Assistant visibility toggles for a seller's custom stall, stored on the
// seller's public kind:30019 shop-profile event
// (content.storefront.assistantVisibility). The chat endpoint reads them
// server-side to gate guest/buyer access; the widget reads the same public
// config via /api/storefront/lookup to decide whether to render.

export interface StallAssistantVisibility {
  buyers: boolean;
  seller: boolean;
}

// Defaults: the assistant is ON for everyone unless the seller opts out —
// shoppers on the stall (a public-catalog-only surface) and the seller alike.
export function readAssistantVisibility(
  shopConfig: unknown
): StallAssistantVisibility {
  const visibility = (
    shopConfig as {
      storefront?: {
        assistantVisibility?: { buyers?: unknown; seller?: unknown };
      };
    } | null
  )?.storefront?.assistantVisibility;
  return {
    buyers: visibility?.buyers !== false,
    seller: visibility?.seller !== false,
  };
}

// Convenience wrapper for the server, which holds the raw event content JSON.
export function parseAssistantVisibilityFromContent(
  contentJson: string | null | undefined
): StallAssistantVisibility & { shopName: string | null } {
  if (!contentJson) return { buyers: true, seller: true, shopName: null };
  try {
    const content = JSON.parse(contentJson) as { name?: unknown };
    return {
      ...readAssistantVisibility(content),
      shopName: typeof content.name === "string" ? content.name : null,
    };
  } catch {
    return { buyers: true, seller: true, shopName: null };
  }
}
