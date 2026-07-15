import { fetchProductsByPubkeyFromDb } from "@/utils/db/db-service";

function isEnabledContactForm(
  section: unknown,
  requireSubscriptionMode: boolean
): boolean {
  if (!section || typeof section !== "object") return false;
  const s = section as {
    type?: unknown;
    enabled?: unknown;
    contactFormMode?: unknown;
  };
  return (
    s.type === "contact_form" &&
    s.enabled !== false &&
    (!requireSubscriptionMode || s.contactFormMode === "subscription")
  );
}

// Anti-abuse fallback for product-page contact forms: besides the storefront
// homepage/custom pages/product-page defaults (all in the kind 30019 config),
// a seller can publish a contact_form section inside a per-product
// `page_config` tag on a kind 30402 listing. Scan their cached products for
// one before refusing to relay mail. Fails closed (false) on any error.
export async function sellerHasProductPageContactForm(
  sellerPubkey: string,
  requireSubscriptionMode: boolean
): Promise<boolean> {
  try {
    const events = await fetchProductsByPubkeyFromDb(sellerPubkey);
    for (const event of events) {
      const tag = (event.tags || []).find((t) => t[0] === "page_config");
      if (!tag || typeof tag[1] !== "string") continue;
      try {
        const cfg = JSON.parse(tag[1]);
        if (
          Array.isArray(cfg?.sections) &&
          cfg.sections.some((s: unknown) =>
            isEnabledContactForm(s, requireSubscriptionMode)
          )
        ) {
          return true;
        }
      } catch {
        // Malformed page_config JSON on one listing shouldn't break the scan.
      }
    }
  } catch (error) {
    console.error("Product page contact-form scan failed:", error);
  }
  return false;
}
