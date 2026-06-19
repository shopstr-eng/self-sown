# Self-Host (Single-Tenant Wrangler Export)

A **Wrangler** (lifetime) seller can run their OWN private copy of Milk Market
that serves exactly one storefront — theirs. The marketplace, discovery, AND all
platform pages (about/faq/producer-guide/contact/terms/privacy) are hidden,
every served page (settings included) wears the seller's storefront theme with
no Milk Market chrome, Pro/Herd is unlocked only for the owner pubkey, and card
payments run on the seller's OWN standard Stripe account (direct charges, no
Connect, no platform fees). When self-host is **off**, every code path below is
inert and the hosted platform behaves exactly as before.

## Configuration (`utils/self-host/config.ts`)

Server-only (imports `fs`/`path`). Reads env first, with an optional
`milk-market.config.json` at the repo root as fallback; **env always wins**.

- `getSelfHostConfig()` → `{ enabled, tenantPubkey, tenantSlug, relays, blossomServers, ownStripe, upstreamRepo }` (memoized; `__resetSelfHostConfigCacheForTests()` clears it).
- `isSelfHost()` → master switch.
- `isSelfHostTenant(pubkey)` → true ONLY for the one configured owner pubkey; **fails closed** (no tenant configured ⇒ nobody is the tenant).
- `normalizeTenantPubkey()` accepts npub or 64-char hex, lowercases, else null.
- `buildSelfHostConfig(env, file)` is the pure builder (test seam).

Env vars (`.env.example`): `MM_SELF_HOST`, `MM_SELF_HOST_PUBKEY`,
`MM_SELF_HOST_SLUG`, `MM_SELF_HOST_RELAYS`, `MM_SELF_HOST_BLOSSOM_SERVERS`,
`MM_SELF_HOST_OWN_STRIPE`, `MM_SELF_HOST_UPSTREAM_REPO`, `MM_SELF_HOST_CONFIG_PATH`.
`ownStripe` auto-enables when `STRIPE_SECRET_KEY` is present unless overridden.

## Entitlement bypass (`utils/pro/membership.ts`)

`getMembershipView(pubkey)` short-circuits to a synthetic **lifetime** row
(status `active`) **only** when `isSelfHostTenant(pubkey)`. `isPubkeyProEntitled`
inherits this transitively. Every other pubkey, and the whole hosted platform,
still resolves from the DB. The pure resolver `membership-status.ts` is untouched
(stays client-safe).

## Proxy routing (`proxy.ts` + `utils/self-host/routing.ts`)

The proxy reads `MM_SELF_HOST*` inline (edge runtime; must not import the
server-only config module) and delegates each decision to the pure helpers:

- `isSelfHostBlockedPage(path)` — marketplace, `/pro`, communities, discovery,
  AND the platform info/legal pages (`/about`, `/faq`, `/producer-guide`,
  `/contact`, `/terms`, `/privacy`) plus bare `npub…`/`naddr…` shortcuts →
  redirect to `/`. Driven by `SELF_HOST_BLOCKED_PAGE_PREFIXES`, matched on an
  exact-or-subpath boundary so a sibling route like `/aboutus` stays live. The
  seller publishes their OWN terms/privacy/return policy as storefront pages via
  the page builder (the platform legal pages are gone in self-host).
- `isSelfHostBlockedApi(path)` — platform billing + Stripe **Connect** routes →
  404, EXCEPT `SELF_HOST_CONNECT_ALLOW` (`/api/stripe/connect/seller-status`,
  made self-host-aware). `/api/pro/status` and `/api/pro/export-store` stay live.
- `selfHostStallRewritePath(path, slug)` — root → `/stall/<slug>`; the proxy
  seeds `x-mm-custom-domain` + `x-mm-self-host` headers so the storefront renders
  as the tenant's stall. When self-host is enabled but the slug is missing the
  proxy **fails closed**: every path returns a 503 misconfiguration error rather
  than falling through to normal multi-tenant routing (which would expose the
  marketplace/discovery/Pro-billing pages).

## UI lockdown & theming (`pages/_app.tsx` + `components/storefront/storefront-theme-wrapper.tsx`)

So the seller only ever sees their OWN branded store (never Milk Market chrome),
self-host forces the storefront theme for EVERY served page — settings and all
non-stall pages included — not just the stall:

- `pages/_app.tsx` forwards the proxy's `x-mm-self-host` header into
  `pageProps.__isSelfHostSsr` (via `getInitialProps`) and passes
  `forceSelfHostChrome` to `StorefrontThemeWrapper` when set. The client-side
  hostname auto-detection effect early-returns under SSR self-host, so there is
  no flash and no double chrome.
- `StorefrontThemeWrapper` treats `forceSelfHostChrome` as entitled
  (`entitled = forceSelfHostChrome || sellerIsPro`) and uses `entitled` for the
  effect guard, deps, and `hasCustomStorefront`. The theme renders immediately
  with default colors, then hydrates the seller's branding — without gating on a
  Pro lookup. `usePublicMembershipStatus` is NOT changed globally; the override
  is local to the wrapper and default-false, so hosted behavior is untouched.

Combined with `isSelfHostBlockedPage`, the net result: no Milk Market TopNav or
footer anywhere, all platform pages hidden, and settings + every page wear the
seller's storefront theme — all inert when self-host is off.

## Payments (own Stripe, direct charges)

- `pages/api/stripe/connect/seller-status.ts` — in self-host, reports the card
  option available (`hasStripeAccount`/`chargesEnabled` true) ONLY for the
  configured tenant pubkey (`isSelfHostTenant`) when `ownStripe` +
  `STRIPE_SECRET_KEY` are set, with NO connected-account id; any other pubkey
  (or a missing key) reports false. Fails closed.
- `pages/api/stripe/create-payment-intent.ts` — in self-host: rejects
  multi-merchant carts (400), refuses the charge when `ownStripe` is off or no
  `STRIPE_SECRET_KEY` is set (server-side gate — hiding the button is not
  authorization), and refuses any `sellerPubkey` that is not the configured
  tenant (the owner's own account is never billed for another seller's item).
  Otherwise forces `singleSellerConnect = null` so the charge lands directly on
  the owner's own account — no Connect routing, application fee, platform
  donation, or Stripe Tax. Lightning/Cashu untouched.

## Export bundle (`pages/api/pro/export-store.ts`)

Wrangler-gated download of a personalized setup bundle (ZIP). Two required gates:

1. Signed Nostr request proof bound to the caller's pubkey + this exact
   action/path (`buildProExportStoreProof`, kind 27235).
2. `getMembershipView(pubkey).isLifetime` must be true — recurring Pro is
   rejected (403). Wrangler-only perk.

The ZIP is assembled by the pure, fs-free `utils/self-host/export-bundle.ts`
(`buildExportEntries`) and packed by the dependency-free
`utils/self-host/zip.ts` (`createZip`, STORE method + CRC32 — **adds no
packages**, keeping lockfiles pristine for `--frozen-lockfile` deploys).

Contents: `milk-market.config.json` (the caller's PUBLIC config — pubkey, slug,
relays, Blossom servers, optional branding snapshot), `.env.example`
(placeholders only), `README.md`, `SETUP.md`, `setup.sh` (git clone upstream +
apply config), `manifest.json`. **Never** includes secrets or another seller's
data: the only inputs are the caller's own public config, a defensive
`stripSecrets()` runs over the branding snapshot, and the generated env template
never reads `process.env`.

## Settings UI

`pages/settings/self-host.tsx` (Wrangler-only; the settings index entry and the
in-page panel are gated on `membership.isLifetime`). It explains the bundle
contents, carries a step-by-step setup guide (get code → database → env → build
→ run, mirroring the bundle's `SETUP.md`, including the note to publish your own
terms/privacy/return policy via the page builder), and triggers the signed
download via `useProMembership().exportSelfHostStore()`.

## Running a self-hosted copy

1. `bash setup.sh` (clones `MM_SELF_HOST_UPSTREAM_REPO`, applies your config).
2. Create a PostgreSQL database; apply `db/schema.sql`.
3. Copy `.env.example` → `.env`; set `DATABASE_URL`, optional `STRIPE_SECRET_KEY`
   (+ `MM_SELF_HOST_OWN_STRIPE=1`), optional `SENDGRID_API_KEY`.
4. `pnpm install && pnpm build && pnpm start`.
5. Update later with `git pull` (your `.env` + `milk-market.config.json` are not
   overwritten).

## Boot smoke check

The bundle's _contents_ are unit-tested in `utils/self-host/__tests__/`. The
end-to-end "does it actually boot?" check that a paying Wrangler seller depends
on lives in `utils/self-host/__tests__/export-bundle-boot.test.ts`. It closes
the loop without needing a full Next build:

1. Pack the REAL bundle (`buildExportEntries` → `createZip`) and extract it back
   out, proving the ZIP round-trips to the full file set.
2. `bash -n` the generated `setup.sh` (syntax-checks the bootstrap without
   running it) and assert it is strict-mode bash that clones the upstream repo.
3. Feed the generated `.env.example` (env path) AND the committed
   `milk-market.config.json` (file-fallback path, for `git pull` sellers) back
   through the ACTUAL runtime reader `buildSelfHostConfig`. This is the key
   guarantee: the bundle's output is in the exact shape the running instance
   consumes, so config drift between export and runtime is caught.
4. Drive the proxy routing helpers with the resolved config to confirm the
   marketplace / discovery / Pro-billing pages are hidden, the tenant's stall is
   served at root (`/` → `/stall/<slug>`), Connect onboarding + platform billing
   APIs are refused while the card seller-status read stays live, and that card
   checkout is OFF until the seller adds their own `STRIPE_SECRET_KEY`.

What the test deliberately does NOT do is run `pnpm build`/`pnpm start`: a cold
Next compile of the whole app is not CI/agent-runnable here (this repo _is_ the
upstream the bundle clones). Lightning/Cashu checkout is fully client-side
(wallet ↔ mint, no server route or secret), so it works the moment the instance
boots — there is no server path for the smoke test to exercise.

### Full-build verification (CI job + manual)

A real compile-and-boot run catches regressions the logical smoke test can't —
e.g. a dependency or route change that breaks the single-tenant build. It runs
two ways:

**CI (automated).** The `self-host-build` job in `.github/workflows/test.yml`
runs `pnpm run test:self-host-build`, which executes
`utils/self-host/__tests__/export-bundle-full-build.test.ts`. That suite is
GATED behind `RUN_SELF_HOST_BUILD=1` (mirroring the `RUN_TESTCONTAINERS`
pattern), so it is skipped in normal `jest` runs and in the agent sandbox (where
a cold Next compile OOMs). When it runs it: generates the REAL bundle, runs the
generated `setup.sh` with the checked-out tree as the clone target, writes a
test `.env` with `MM_SELF_HOST=1` (no Stripe key), runs `pnpm install` +
`pnpm build`, boots with `pnpm start`, and asserts over real HTTP that `/` serves
the tenant stall (200), `/marketplace` and `/pro` redirect home (307 → `/`), and
the cart offers Lightning/Cashu only (the seller-status endpoint reports card
off without a `STRIPE_SECRET_KEY`). The job provides a Postgres service +
`db/schema.sql` so the stall SSR has a database.

**Manual.** To confirm a real boot before a release that touches the bundle or
self-host runtime, generate a bundle from a Wrangler account's settings page (or
call the exported pure builder), then in a scratch directory:

```bash
bash setup.sh                 # clones MM_SELF_HOST_UPSTREAM_REPO → ./milk-market
cd milk-market
cp ../.env.example .env        # set DATABASE_URL; optionally add STRIPE_SECRET_KEY
psql "$DATABASE_URL" -f db/schema.sql
pnpm install && pnpm build && pnpm start
```

Then spot-check: visiting `/` serves the seller's storefront, `/marketplace`
and `/pro` redirect home, and the cart offers Lightning/Cashu (card only when a
Stripe key was added). Fold any drift back into `setup.sh` / the env template.

## License

Milk Market is GNU AGPL/GPL v3. Running and modifying your own copy is within
your rights; network-distributed modifications must be shared under the same
license.
