---
name: MCP tier enforcement & custom-stall parity
description: Where MCP access is cut off when a seller loses the paid tier, and the rule that set_shop_profile must mirror the StorefrontConfig model.
---

# MCP API-key revocation on tier downgrade

When a seller falls off the paid (Herd/Wrangler) tier their MCP API keys are
bulk-deactivated (`is_active=FALSE`), not hard-deleted.

**Why deactivate, not delete:** the MCP orders table has an `api_key_id` FK to
`mcp_api_keys(id)`; a hard delete would violate it. `validateApiKey` only matches
`is_active=TRUE`, so deactivation fully blocks access while keeping FK integrity.

**Where the hook lives:** the Pro lifecycle cron (`runProLifecycle`) at the
**readonly** transition (the first non-entitled state — entitled = trialing /
active / grace; non-entitled = readonly / hidden), and again at **hidden** in case
the cron never observed the readonly window. Both are gated by the one-time
`readonly_notice_sent_at` / `hidden_notice_sent_at` flags.

**How to apply / why it's correct across re-subscribe:** those notice flags are
reset to NULL on every fresh paid period (in the membership writers), so the
revoke re-fires after a re-subscribe→lapse cycle. Revocation is best-effort
(errors logged, not thrown) so a DB hiccup never blocks the lifecycle notices.
Defense-in-depth already exists at request time (`authenticateRequest` /
`/api/mcp` reject non-entitled key owners via `isApiKeyOwnerProEntitled`), so the
cron deactivation is cleanup, not the only gate.

# set_shop_profile must mirror StorefrontConfig

The MCP `set_shop_profile` tool (mcp/tools/write-tools.ts) hand-maps each storefront
param into the kind-30019 `content.storefront` object. **Any new field added to
`StorefrontConfig` (packages/domain/src/storefront.ts) must also be added to both
the set_shop_profile zod schema AND its handler mapping**, or agents silently can't
configure it. `get_storefront` spreads the raw storefront object, so reads come
back automatically — the write side is the one that drifts.

**Why:** fields like customFontHeadingUrl/Name, customFontBodyUrl/Name, neoShadows,
navColors, footerColors, seoMeta existed in the model but were unsettable via MCP
until explicitly threaded through. Treat set_shop_profile as a surface that must be
checked whenever storefront styling/SEO fields are added.
