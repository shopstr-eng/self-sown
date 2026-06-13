---
name: Stripe-connect auth fallback binding
description: Why state-changing stripe-connect endpoints must pass an expectedBinding to the verifyNostrAuth fallback, not just the bare "stripe-connect" action.
---

The stripe-connect API endpoints authenticate with a PRIMARY single-use MCP request-proof
(`verifyAndConsumeSignedRequestProof`, the shipped client signs
`buildMcpRequestProofTemplate(buildStripe...Proof)`). On primary failure they fall back to
`verifyNostrAuth(event, pubkey, "stripe-connect")`.

**Rule:** any _state-changing_ stripe-connect endpoint must pass an `expectedBinding`
`{ method, path }` to that fallback (e.g. disconnect, tax-settings). Mirror the
storefront-slug-write / custom-domain-write pattern.

**Why:** the bare fallback only checks `action="stripe-connect"` + pubkey + a 600s freshness
window — no operation binding and no single-use. A _generic_ stripe-connect auth event
(action tag only, no method/path tags) signed for one purpose (e.g. a read like
account-status) can therefore be replayed cross-endpoint into a destructive write
(disconnect, tax flips). Note: a replayed _MCP proof_ is already safe here because it carries
`action="stripe_disconnect"`/`"stripe_tax_settings"`, which fails the fallback's
`expectedAction="stripe-connect"` check — so the hole is specifically the unbound generic event.

**How to apply:** when adding/auditing a state-changing stripe-connect endpoint, add
`{ method: "POST", path: "/api/stripe/connect/<endpoint>" }` as the 4th arg to the fallback
`verifyNostrAuth`. ALL current write endpoints are now bound: disconnect, tax-settings,
manage-link, create-account, create-account-link.

**Critical client-dependency caveat:** the bare fallback is NOT universally dead — before
binding an endpoint, check which client actually reaches it. Two clients exist: the WEB
client signs full MCP request-proofs (primary path — a binding never affects it). The EXPO
MOBILE client (`apps/mobile/app/(tabs)/index.tsx`) authenticates to create-account /
create-account-link with a GENERIC action-only seller-action event (no method/path tags) and
relies ENTIRELY on the fallback; binding those two without updating mobile 401s onboarding.
The coordinated fix that made them safe: `createSignedSellerActionAuthEvent` /
`createSignedStripeConnectAuthEvent` take an OPTIONAL `binding` (forwarded into
`createSellerActionAuthEventTemplate`), and the two mobile call sites now sign the matching
binding. account-status (read-only) stays unbound — mobile's status check signs an unbound
event, so leave it alone. **Accepted cost:** older mobile binaries signing unbound events get
401 on create-account/create-account-link until users update the app (user-approved).

**Validation gap:** tsc/eslint/prettier/build do NOT catch this regression — only running the
jest suite (create-account-link.test.ts) or knowing the mobile client surfaces it. The test
must sign with the same binding or it 401s. (Mobile typecheck only sees the new helper
signature after the pnpm-injected copy is resynced — see pnpm-injected-workspace-deps.md.)
