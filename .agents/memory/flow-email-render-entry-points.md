---
name: Flow email styling has two server render entry points
description: Any "apply X to flow emails" change must touch BOTH render paths; test sends don't go through the flow processor.
---

# Flow emails render in two separate server paths

`renderFlowEmail()` (utils/email/flow-email-templates.ts) is the single HTML
builder, but it is invoked from **two independent server entry points**, plus a
client preview:

- `pages/api/email/flows/process.ts` — sends BOTH multi-step flows AND one-time
  emails. One-time sends enroll contacts via `send-to-contacts.ts` (which only
  enrolls/schedules, no rendering) and are then rendered+sent here. This path
  loads the seller's saved storefront style server-side and applies it by default.
- `pages/api/email/flows/[flowId]/send-test.ts` — the seller "send me a test"
  preview. NIP-98 authed; renders independently of the processor.
- `components/settings/flow-step-editor.tsx` — client-side preview only, never sends.

**Why this matters:** because test sends do NOT pass through `process.ts`, any
change to how flow emails look/behave (styling, tracking, merge tags) must be
applied in BOTH `process.ts` and `send-test.ts` or the test preview diverges from
what real recipients receive. Historically `send-test` relied on the dashboard
passing `storefront_style` (null whenever the client shop context wasn't loaded),
so test emails arrived unstyled while real sends were styled — fixed by having
`send-test` fall back to `loadStorefrontBranding(authResult.pubkey)`.

**How to apply:** prefer the shared `loadStorefrontBranding()` helper
(utils/email/storefront-branding.ts — fail-closed, cached, sanitizes hex) for any
new seller-branding lookup. Note `process.ts` still uses its own inline,
unsanitized `getStorefrontStyle`; for valid hex configs both produce identical
styles, but unify on the shared helper if exact parity under malformed data is
ever required.
