/** @jest-environment node */

/**
 * Guard for the standing share-link rule (docs/architecture/affiliates.md):
 * any link we GENERATE for sharing a seller's store must prefer their
 * verified custom domain over the platform /stall/<slug> URL. The rule lives
 * in exactly two places:
 *
 *   - server: resolveSellerStorefrontUrl / resolveSellerCustomDomainUrl
 *     (utils/db/custom-domains.ts)
 *   - client: prefetchSellerCustomDomainBaseUrl /
 *     getCachedSellerCustomDomainBaseUrl (utils/storefront/seller-share-url.ts)
 *
 * Nothing otherwise stops a new page, email template, or MCP tool from
 * hand-building `${getSiteUrl()}/stall/${slug}` (or window.location.origin +
 * `/stall/${slug}`) and silently breaking the rule. This test scans pages/,
 * components/, utils/, and mcp/ for source that CONSTRUCTS a /stall/ URL and
 * fails unless the file either references a shared resolver or is explicitly
 * allowlisted below with the reason it is exempt.
 *
 * Legitimate exception categories (see ALLOWLIST):
 *   - the resolvers themselves and in-storefront RELATIVE navigation
 *     (router.push / href between pages of the same stall)
 *   - proxy/rewrite/canonical layers that already handle customHost
 *   - surfaces that must name the platform URL by contract (sitemap,
 *     agent-view content identity)
 *   - MCP tools that resolve the verified custom domain inline against
 *     their own dbPool before falling back
 */

import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..", "..", "..");
const SCAN_DIRS = ["pages", "components", "utils", "mcp"];

// A line CONSTRUCTS a /stall/ URL when it interpolates into the path
// (`/stall/${x}`), appends the path to an interpolated base
// (`${base}/stall/...`), or concatenates a literal ('/stall/' + x). Bare
// prefix checks like startsWith("/stall/") and prose comments using
// "/stall/<slug>" do not match.
const CONSTRUCTION =
  /(?:\/stall\/\$\{|\}\s*\/stall\/|["'`]\/stall\/["'`]\s*\+)/;

const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

// Referencing a shared resolver makes a file compliant even though it still
// contains the platform /stall/<slug> path as the resolver's fallback arm
// (e.g. `customDomainBase ? `${base}/listing/x` : `${origin}/stall/s/...`).
const HELPER_REF =
  /\b(?:resolveSellerStorefrontUrl|resolveSellerCustomDomainUrl|getCachedSellerCustomDomainBaseUrl|prefetchSellerCustomDomainBaseUrl)\b/;

/**
 * Files allowed to construct /stall/ URLs WITHOUT a shared resolver. Every
 * entry needs a reason; a NEW share-link surface does not belong here — it
 * belongs behind resolveSellerStorefrontUrl (server) or
 * prefetch/getCachedSellerCustomDomainBaseUrl (client).
 */
const ALLOWLIST: Record<string, string> = {
  // --- proxy / rewrite / canonical layers -------------------------------
  "utils/self-host/routing.ts":
    "self-host proxy: maps root-mapped paths onto the internal /stall/<slug> rewrite target",
  "utils/storefront/custom-domain-context.tsx":
    "strips the /stall/<slug> prefix when already rendering on a custom domain",
  "utils/storefront-links.ts":
    "prefixes persisted in-storefront links for relative navigation, never an absolute share URL",
  "pages/stall/[slug].tsx":
    "canonical/OG layer for the stall page itself; switches on customHost explicitly",
  "pages/stall/[...stallPath].tsx":
    "canonical/OG layer for stall subpages; switches on customHost explicitly",
  "pages/api/stall-agent-view.ts":
    "machine-readable content identity; the slug arrives from the proxy and the URL must match the serving origin",
  "pages/api/sitemap.xml.ts":
    "the platform sitemap must list platform URLs; a custom domain serves its own host's sitemap",
  // --- relative navigation (no absolute URL leaves the app) -------------
  "pages/cart/index.tsx":
    "internal navigation within a stall-scoped checkout session",
  "pages/listing/[[...productId]].tsx":
    "canonical relative path while already on the stall-scoped route",
  "pages/index.tsx":
    "hardcoded marketing links to specific demo stalls, not per-seller share links",
  "components/home/marketplace.tsx":
    "internal navigation (router.push) from a marketplace card",
  "components/listing/product-listing-view.tsx":
    "internal navigation to the stall-scoped order-confirmation page",
  "components/settings/shop-profile-form.tsx":
    "slug-input prefix display plus the owner's internal 'open storefront' link",
  "components/utility-components/profile/profile-dropdown.tsx":
    "internal navigation to the signed-in user's own stall",
  "components/storefront/storefront-nav.tsx":
    "in-storefront relative nav links",
  "components/storefront/storefront-layout.tsx":
    "in-storefront relative navigation",
  "components/storefront/storefront-footer.tsx":
    "in-storefront relative policy links",
  "components/storefront/storefront-theme-wrapper.tsx":
    "in-storefront relative navigation",
  "components/storefront/storefront-order-confirmation.tsx":
    "in-storefront relative navigation (already custom-domain aware)",
  "components/storefront/themed-blog.tsx": "in-storefront relative navigation",
  "components/storefront/themed-stall-orders.tsx":
    "in-storefront relative navigation",
  "components/storefront/sections/section-blog.tsx":
    "in-storefront relative navigation",
  "components/storefront/sections/section-related-products.tsx":
    "in-storefront relative navigation",
  // --- MCP tools (inline resolution against the MCP dbPool) -------------
  "mcp/tools/read-tools.ts":
    "resolves the verified custom domain inline before falling back to the /stall/<slug> path",
  "mcp/tools/write-tools.ts":
    "resolves the verified custom domain inline before falling back to the /stall/<slug> path",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...walk(full));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function constructingLines(file: string): string[] {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const hits: string[] = [];
  lines.forEach((line, i) => {
    if (COMMENT_LINE.test(line)) return;
    if (CONSTRUCTION.test(line)) hits.push(`${rel(file)}:${i + 1}`);
  });
  return hits;
}

describe("share-link custom-domain guard", () => {
  it("keeps the shared resolvers exported under their contract names", () => {
    const server = fs.readFileSync(
      path.join(ROOT, "utils/db/custom-domains.ts"),
      "utf8"
    );
    expect(server).toMatch(/export async function resolveSellerStorefrontUrl/);
    expect(server).toMatch(
      /export async function resolveSellerCustomDomainUrl/
    );

    const client = fs.readFileSync(
      path.join(ROOT, "utils/storefront/seller-share-url.ts"),
      "utf8"
    );
    expect(client).toMatch(/export function prefetchSellerCustomDomainBaseUrl/);
    expect(client).toMatch(
      /export function getCachedSellerCustomDomainBaseUrl/
    );
  });

  it("fails when a file constructs /stall/ URLs without a shared resolver or allowlist entry", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const relPath = rel(file);
        if (relPath === "utils/db/custom-domains.ts") continue; // the resolver itself
        const hits = constructingLines(file);
        if (hits.length === 0) continue;
        if (HELPER_REF.test(fs.readFileSync(file, "utf8"))) continue;
        if (ALLOWLIST[relPath]) continue;
        offenders.push(...hits);
      }
    }
    // Assert on a string so the failure output carries the guidance.
    const report = offenders.length
      ? `These files build /stall/ URLs directly. Generated links to a ` +
        `seller's store must prefer their verified custom domain: use ` +
        `resolveSellerStorefrontUrl (utils/db/custom-domains.ts) server-side ` +
        `or prefetch/getCachedSellerCustomDomainBaseUrl ` +
        `(utils/storefront/seller-share-url.ts) client-side. Add an ALLOWLIST ` +
        `entry with a reason only for proxy rewrites, in-storefront relative ` +
        `navigation, or surfaces contractually bound to the platform URL.\n` +
        offenders.join("\n")
      : "";
    expect(report).toBe("");
  });

  it("keeps the allowlist free of stale entries", () => {
    const stale: string[] = [];
    for (const relPath of Object.keys(ALLOWLIST)) {
      const full = path.join(ROOT, relPath);
      if (!fs.existsSync(full)) {
        stale.push(`${relPath} (file no longer exists)`);
        continue;
      }
      if (
        constructingLines(full).length === 0 &&
        !HELPER_REF.test(fs.readFileSync(full, "utf8"))
      ) {
        stale.push(`${relPath} (no longer constructs a /stall/ URL)`);
      }
    }
    expect(
      stale.length
        ? `Remove these ALLOWLIST entries (or re-add the construction):\n${stale.join("\n")}`
        : ""
    ).toBe("");
  });

  it("keeps the rule documented with both helpers named", () => {
    const doc = fs.readFileSync(
      path.join(ROOT, "docs/architecture/affiliates.md"),
      "utf8"
    );
    expect(doc).toMatch(/resolveSellerStorefrontUrl/);
    expect(doc).toMatch(/seller-share-url\.ts/);
  });
});
