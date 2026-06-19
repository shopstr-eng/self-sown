// Builds the self-host export bundle contents (pure, no fs / no secrets).
//
// Given the owner's PUBLIC storefront config (pubkey, slug, relays, Blossom
// servers, an optional branding snapshot), this assembles the files that go into
// the downloadable ZIP. It NEVER reads process.env or any secret — the only
// inputs are the caller's own public config, and a defensive secret-stripper
// runs over the branding snapshot so an over-sharing client can't smuggle a key
// into the bundle. The generated .env.example contains placeholders only.

import { DEFAULT_UPSTREAM_REPO } from "@/utils/self-host/config";
import type { ZipEntry } from "@/utils/self-host/zip";

export interface ExportBundleInput {
  // Owner pubkey (hex, lowercase) — already proven via signed request auth.
  pubkey: string;
  slug?: string | null;
  relays?: unknown;
  blossomServers?: unknown;
  // Optional storefront branding snapshot (colors/fonts/name/etc.). Public data;
  // sanitized defensively before inclusion.
  branding?: unknown;
  upstreamRepo?: string | null;
  generatedAt?: string;
}

// Keys whose name suggests a credential. Any matching key (at any depth) is
// dropped from the branding snapshot before it's written into the bundle.
const SECRET_KEY_PATTERN =
  /(secret|password|passwd|api[_-]?key|apikey|token|bearer|authorization|nsec|priv(ate)?[_-]?key|seed|mnemonic|credential|client[_-]?secret|access[_-]?key)/i;

const MAX_LIST_ITEMS = 50;
const MAX_BRANDING_BYTES = 100 * 1024;
const MAX_DEPTH = 8;

// Recursively strip secret-looking keys from a plain JSON value. Non-plain
// values (functions, etc.) and anything past MAX_DEPTH are dropped.
export function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .map((v) => stripSecrets(v, depth + 1))
      .filter((v) => v !== undefined);
  }
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) continue;
      const cleaned = stripSecrets(v, depth + 1);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return undefined;
}

function sanitizeUrlList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s) continue;
    if (!/^(wss?|https?):\/\//i.test(s)) continue;
    out.push(s);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}

function sanitizeSlug(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  // Slugs are URL path segments; keep it conservative.
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(s)) return null;
  return s;
}

// Validate the upstream repo URL before it is interpolated into setup.sh and
// the generated docs. Only accept a clean http(s)/git/ssh URL (or scp-style
// git@host:path) made of safe characters, so a crafted value can never inject
// shell commands into the bootstrap script. Anything else falls back to the
// canonical public repo.
function sanitizeUpstreamRepo(value: string | null | undefined): string {
  if (typeof value !== "string") return DEFAULT_UPSTREAM_REPO;
  const s = value.trim();
  if (!s) return DEFAULT_UPSTREAM_REPO;
  const isUrl = /^(https?|git|ssh):\/\/[A-Za-z0-9._~:/?#@%+-]+$/.test(s);
  const isScp = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[A-Za-z0-9._~/-]+$/.test(s);
  return isUrl || isScp ? s : DEFAULT_UPSTREAM_REPO;
}

function sanitizeBranding(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cleaned = stripSecrets(value);
  if (!cleaned || typeof cleaned !== "object") return null;
  // Cap the serialized size so a huge snapshot can't bloat the bundle.
  const serialized = JSON.stringify(cleaned);
  if (serialized.length > MAX_BRANDING_BYTES) return null;
  return cleaned as Record<string, unknown>;
}

export interface SelfHostConfigJson {
  pubkey: string;
  slug: string | null;
  relays: string[];
  blossomServers: string[];
  ownStripe: boolean;
  upstreamRepo: string;
  branding?: Record<string, unknown>;
}

export function buildSelfHostConfigJson(
  input: ExportBundleInput
): SelfHostConfigJson {
  const upstreamRepo = sanitizeUpstreamRepo(input.upstreamRepo);
  const branding = sanitizeBranding(input.branding);
  return {
    pubkey: input.pubkey,
    slug: sanitizeSlug(input.slug),
    relays: sanitizeUrlList(input.relays),
    blossomServers: sanitizeUrlList(input.blossomServers),
    // Default off: the seller turns it on once they add their own Stripe key.
    ownStripe: false,
    upstreamRepo,
    ...(branding ? { branding } : {}),
  };
}

function envExampleTemplate(config: SelfHostConfigJson): string {
  const relays = config.relays.join(",");
  const blossom = config.blossomServers.join(",");
  return `# Milk Market self-host (single-tenant) environment.
# Copy this file to ".env" and fill in the values. NEVER commit your real .env.
# This template ships with NO secrets; every value below is a placeholder.
#
# Legend:
#   [required]  the store will not run without it
#   [generate]  a secret YOU create yourself (a long random string or new key)
#   [optional]  only needed for that one feature

# === Self-host identity (pre-filled from your export) ========================
# Turn on single-tenant self-host mode.
MM_SELF_HOST=1
# Your Nostr pubkey (the one this store belongs to). Pre-filled from your export.
MM_SELF_HOST_PUBKEY=${config.pubkey}
# Your storefront slug. Pre-filled from your export.
MM_SELF_HOST_SLUG=${config.slug ?? ""}
# Your relays / Blossom media servers (comma-separated). Pre-filled.
MM_SELF_HOST_RELAYS=${relays}
MM_SELF_HOST_BLOSSOM_SERVERS=${blossom}
# Public repo to pull code updates from.
MM_SELF_HOST_UPSTREAM_REPO=${config.upstreamRepo}

# === Required ================================================================
# [required] PostgreSQL connection string. Apply db/schema.sql to a fresh DB first.
DATABASE_URL=postgresql://user:password@host:5432/milkmarket
# [required] The public URL your store is served from (NO trailing slash).
# Used for links, emails, SEO/social tags, and payment redirects.
NEXT_PUBLIC_BASE_URL=https://yourstore.example

# === File & image uploads (recommended) =====================================
# [generate] A dedicated Nostr private key (starts with "nsec") used to encrypt
# uploaded images/files and to send server-side messages. Generate a NEW key,
# do NOT reuse your personal nsec. Any Nostr key generator works. Without it,
# uploads that rely on encryption will fail.
ENCRYPTION_NSEC=

# === Card payments via YOUR own Stripe account (optional) ===================
# Lightning and Cashu checkout work with NO secrets. Add cards only if you want
# them. All THREE values below are needed for cards; then flip OWN_STRIPE on.
# Charges run directly on YOUR account (no Connect, no platform fees).
# [optional] Your standard Stripe secret key.
STRIPE_SECRET_KEY=
# [optional] Your Stripe publishable key (renders the card form in the browser).
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
# [optional] Signing secret for your Stripe payment webhook (confirms orders).
# Add a Stripe webhook pointing at /api/stripe/webhook and paste its secret.
STRIPE_WEBHOOK_SECRET=
# Flip this on once the three Stripe values above are filled in.
# MM_SELF_HOST_OWN_STRIPE=1

# === Email (optional) =======================================================
# [optional] Transactional email via SendGrid. Leave blank to disable email.
SENDGRID_API_KEY=
# [generate] Only if you use automated email flows: long random strings that
# sign email links and authorize the flow processor.
EMAIL_FLOW_CLICK_SECRET=
FLOW_PROCESSOR_SECRET=

# === AI agents / MCP API (optional) =========================================
# [generate] Only if you enable the MCP API for AI agents: a long random string
# used to encrypt stored agent keys.
MCP_ENCRYPTION_KEY=
`;
}

function readmeMarkdown(config: SelfHostConfigJson): string {
  return `# Milk Market: Your Self-Hosted Store

This bundle wires a self-hosted, single-tenant copy of Milk Market to YOUR
storefront. The marketplace and other sellers are hidden; this instance serves
only your shop.

## What's in here

- \`milk-market.config.json\`: your public store config (pubkey, slug, relays,
  Blossom servers${
    config.branding ? ", branding snapshot" : ""
  }). **No secrets.**
- \`.env.example\`: environment template (placeholders only). Copy to \`.env\`.
- \`setup.sh\`: clones the public code repo and drops your config in place.
- \`SETUP.md\`: full step-by-step setup guide.
- \`manifest.json\`: bundle metadata.

## Quick start

\`\`\`bash
bash setup.sh                            # clones ${config.upstreamRepo} + applies your config
cd milk-market
cp ../.env.example .env                   # then fill in .env (see SETUP.md)
psql "$DATABASE_URL" -f db/schema.sql     # create the database tables
pnpm install
pnpm build && pnpm start
\`\`\`

At a minimum, set \`DATABASE_URL\` and \`NEXT_PUBLIC_BASE_URL\` in \`.env\`, and
generate an \`ENCRYPTION_NSEC\` (used to encrypt image/file uploads). Cards, email,
and the AI agent API are all optional add-ons. \`SETUP.md\` explains every value.

## Updating

Your store tracks the public repo. To pull the latest code:

\`\`\`bash
cd milk-market
git pull
pnpm install
pnpm build && pnpm start
\`\`\`

Your \`milk-market.config.json\` and \`.env\` are yours and are not overwritten by
\`git pull\`.

## Your store pages & policies

This instance shows ONLY your storefront. The Milk Market marketplace, the
platform info pages (About, FAQ, Producer Guide, Contact), and the platform
Terms/Privacy pages are all hidden. Publish your OWN terms, privacy, and return
policy as storefront pages using the page builder under **Settings**.

## License

Milk Market is released under the GNU AGPL/GPL v3. Running your own copy is
fully within your rights under that license; if you distribute a modified
version or offer it over a network, you must make your source available under
the same license. See the LICENSE file in the cloned repo.
`;
}

function setupMarkdown(config: SelfHostConfigJson): string {
  return `# Self-Host Setup Guide

## 1. Get the code

\`\`\`bash
bash setup.sh
# or manually:
git clone ${config.upstreamRepo} milk-market
cd milk-market
cp ../milk-market.config.json ./milk-market.config.json
\`\`\`

## 2. Database (PostgreSQL)

Create a fresh PostgreSQL database and apply the schema:

\`\`\`bash
psql "$DATABASE_URL" -f db/schema.sql
\`\`\`

## 3. Environment

\`\`\`bash
cp ../.env.example .env
\`\`\`

Edit \`.env\` (it has inline notes and a [required]/[generate]/[optional] legend):

- \`DATABASE_URL\`: **[required]** your PostgreSQL connection string.
- \`NEXT_PUBLIC_BASE_URL\`: **[required]** the public URL your store is served
  from, with NO trailing slash. Used for links, emails, and social/SEO tags.
- \`MM_SELF_HOST*\`: pre-filled from your export; adjust relays if needed.
- \`ENCRYPTION_NSEC\`: **[generate]** a NEW Nostr private key (\`nsec...\`) used to
  encrypt uploaded images/files and to send server-side messages. Do NOT reuse
  your personal key. Without it, uploads that rely on encryption will fail.
- **Card payments (optional).** To accept cards on YOUR own Stripe account, set
  all three: \`STRIPE_SECRET_KEY\`, \`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY\`, and
  \`STRIPE_WEBHOOK_SECRET\` (add a Stripe webhook pointing at
  \`/api/stripe/webhook\` and paste its signing secret). Then set
  \`MM_SELF_HOST_OWN_STRIPE=1\`. Charges run directly on your account, with no
  Connect, no platform fees.
- **Email (optional).** \`SENDGRID_API_KEY\` for transactional email. If you use
  automated email flows, also **[generate]** \`EMAIL_FLOW_CLICK_SECRET\` and
  \`FLOW_PROCESSOR_SECRET\` (any long random strings).
- **AI agents (optional).** **[generate]** \`MCP_ENCRYPTION_KEY\` (any long random
  string) to enable the MCP API for AI shopping agents.

Lightning and Cashu checkout work out of the box with no server secrets.

## 4. Build and run

\`\`\`bash
pnpm install
pnpm build
pnpm start
\`\`\`

The site serves your storefront at the root URL. Everything visitors see is
your branded storefront; the marketplace, discovery, platform info pages
(About, FAQ, Producer Guide, Contact), the platform Terms/Privacy pages, and
platform billing are all hidden. Even your Settings pages use your storefront
theme.

## 5. Your store policies (terms, privacy, returns)

Because the platform's legal pages are hidden, publish your OWN terms, privacy,
and return policy as storefront pages. In **Settings**, use the storefront page
builder to add policy pages and link them from your storefront footer.

## 6. Stay updated

\`\`\`bash
cd milk-market
git pull
pnpm install
pnpm build && pnpm start
\`\`\`

## License (AGPL/GPL v3)

This software is licensed under the GNU AGPL/GPL v3. You may run and modify it
freely; network-distributed modifications must be shared under the same license.
`;
}

function setupScript(config: SelfHostConfigJson): string {
  return `#!/usr/bin/env bash
# Milk Market self-host bootstrap. Run from the unzipped bundle directory.
set -euo pipefail

REPO="\${1:-${config.upstreamRepo}}"
TARGET="\${2:-milk-market}"

echo "Cloning \$REPO into ./\$TARGET ..."
git clone "\$REPO" "\$TARGET"

echo "Applying your store config ..."
cp "milk-market.config.json" "\$TARGET/milk-market.config.json"

echo ""
echo "Done. Next steps:"
echo "  cd \$TARGET"
echo "  cp ../.env.example .env   # then edit .env (DATABASE_URL, optional Stripe key)"
echo "  psql \\"\\\$DATABASE_URL\\" -f db/schema.sql"
echo "  pnpm install && pnpm build && pnpm start"
`;
}

function manifestJson(config: SelfHostConfigJson, generatedAt: string): string {
  return JSON.stringify(
    {
      bundle: "milk-market-self-host",
      version: 1,
      generatedAt,
      pubkey: config.pubkey,
      slug: config.slug,
      upstreamRepo: config.upstreamRepo,
      contents: [
        "milk-market.config.json",
        ".env.example",
        "setup.sh",
        "README.md",
        "SETUP.md",
        "manifest.json",
      ],
      note: "Config only; no secrets or other sellers' data are included.",
    },
    null,
    2
  );
}

// Assemble the full set of bundle files for the ZIP. Pure — safe to unit test.
export function buildExportEntries(input: ExportBundleInput): ZipEntry[] {
  const config = buildSelfHostConfigJson(input);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  return [
    {
      name: "milk-market.config.json",
      data: JSON.stringify(config, null, 2) + "\n",
    },
    { name: ".env.example", data: envExampleTemplate(config) },
    { name: "README.md", data: readmeMarkdown(config) },
    { name: "SETUP.md", data: setupMarkdown(config) },
    { name: "setup.sh", data: setupScript(config) },
    { name: "manifest.json", data: manifestJson(config, generatedAt) + "\n" },
  ];
}
