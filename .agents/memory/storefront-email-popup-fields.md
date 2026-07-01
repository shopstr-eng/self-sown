---
name: Storefront email-popup config field threading
description: Where a new StorefrontEmailPopup field must be wired, and the surfaces that do/don't carry it.
---

Adding a field to `StorefrontEmailPopup` (the seller contact-capture popup):

- The config is parsed straight from the kind:30019 storefront JSON with **no field-stripping sanitizer** (unlike `StorefrontSection`, which has dual sanitizers — see adding-storefront-section-type.md). So a new field round-trips automatically through save/load once you add it to the type + write it in the settings form + read it in the render component. No sanitizer wiring needed.

- Real surfaces to touch: the type in `packages/domain/src/storefront.ts` (re-exported via `utils/types/types.ts`), the settings UI `components/settings/shop-profile-form.tsx` (the `emailPopup` state + Email Capture Popup section), and the renderer `components/storefront/storefront-email-popup.tsx` (instantiated only from `storefront-layout.tsx`).

**Why:** it's tempting to hunt for a popup sanitizer like sections have — there isn't one, so don't add one.

**MCP surface is `set_email_popup`** (in `mcp/tools/write-tools.ts`), a tool separate from the settings UI. A new field needs its own zod param in the tool schema AND a `params.x !== undefined` assignment in the handler, or agents can't set it (`displayMode` is wired). The handler now spreads the existing `content.storefront.emailPopup` first, so omitted fields (incl. `style` background image/colors and `flowSteps`) are PRESERVED — it no longer rebuilds from scratch. `enabled` + `discountPercentage` are required params so they always overwrite.
