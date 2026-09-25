// Assistant visibility toggles for a seller's custom stall, stored on the
// seller's public kind:30019 shop-profile event
// (content.storefront.assistantVisibility). The chat endpoint reads them
// server-side to gate guest/buyer access; the widget reads the same public
// config via /api/storefront/lookup to decide whether to render.

export interface StallAssistantVisibility {
  buyers: boolean;
  seller: boolean;
}

// Defaults: buyer/guest-facing assistant is OPT-IN (a public AI surface on
// every stall shouldn't appear unasked); the seller sees their own assistant
// unless they explicitly hide it.
export function readAssistantVisibility(
  shopConfig: unknown
): StallAssistantVisibility {
  const visibility = (
    shopConfig as {
      storefront?: { assistantVisibility?: { buyers?: unknown; seller?: unknown } };
    } | null
  )?.storefront?.assistantVisibility;
  return {
    buyers: visibility?.buyers === true,
    seller: visibility?.seller !== false,
  };
}

// Convenience wrapper for the server, which holds the raw event content JSON.
export function parseAssistantVisibilityFromContent(
  contentJson: string | null | undefined
): StallAssistantVisibility & { shopName: string | null } {
  if (!contentJson) return { buyers: false, seller: true, shopName: null };
  try {
    const content = JSON.parse(contentJson) as { name?: unknown };
    return {
      ...readAssistantVisibility(content),
      shopName: typeof content.name === "string" ? content.name : null,
    };
  } catch {
    return { buyers: false, seller: true, shopName: null };
  }
}
