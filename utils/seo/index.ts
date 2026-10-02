// Aggregation layer for the comparison/guide pages: one registry keyed by
// path, consumed by the route components, dynamic-meta-head (titles),
// sitemap.xml, proxy.ts agent negotiation, and page-content.ts (markdown
// for agents). Add a page to vs-pages/alternatives-pages/guides and every
// surface picks it up — nothing else to register by hand.

import { PRICING_DISCLAIMER, SEO_CTA, type SeoPageContent } from "./model";
import { VS_PAGES } from "./vs-pages";
import { ALTERNATIVES_PAGES } from "./alternatives-pages";
import { GUIDES } from "./guides";

const HUB_PAGES: Record<string, SeoPageContent> = {};

// Keyed by PATH ("/vs/shopify"), not slug: VS_PAGES and ALTERNATIVES_PAGES
// share the same slugs ("shopify" etc.), so a naive spread of the
// slug-keyed maps would have alternatives clobber the vs entries.
export const SEO_PAGES: Record<string, SeoPageContent> = Object.fromEntries(
  [
    ...Object.values(VS_PAGES),
    ...Object.values(ALTERNATIVES_PAGES),
    ...Object.values(GUIDES),
    ...Object.values(HUB_PAGES),
  ].map((page) => [page.path, page])
);

/** All SEO page paths, for the sitemap. Hub indexes are included. */
export const SEO_PAGE_PATHS: string[] = [
  "/vs",
  ...Object.values(VS_PAGES).map((p) => p.path),
  "/alternatives",
  ...Object.values(ALTERNATIVES_PAGES).map((p) => p.path),
  "/best",
  ...Object.values(GUIDES).map((p) => p.path),
];

export function getSeoPage(path: string): SeoPageContent | null {
  return SEO_PAGES[path] ?? null;
}

/** Title/description for dynamic-meta-head — returns null for unknown paths. */
export function getSeoPageMeta(
  path: string
): { title: string; description: string } | null {
  const page = getSeoPage(path);
  return page
    ? { title: page.metaTitle, description: page.metaDescription }
    : null;
}

function tableToMarkdown(table: {
  columns: string[];
  rows: string[][];
}): string {
  const header = `| ${table.columns.join(" | ")} |`;
  const sep = `| ${table.columns.map(() => "---").join(" | ")} |`;
  const rows = table.rows.map((r) => `| ${r.join(" | ")} |`);
  return [header, sep, ...rows].join("\n");
}

/** Render a page as markdown — the agent-view representation. */
export function seoPageToMarkdown(page: SeoPageContent, site: string): string {
  const parts: string[] = [];
  parts.push(`# ${page.h1}`);
  parts.push(`*${page.disclosure}*`);
  for (const p of page.intro) parts.push(p);
  if (page.table) parts.push(tableToMarkdown(page.table));
  for (const section of page.sections) {
    parts.push(`## ${section.heading}`);
    for (const p of section.paragraphs ?? []) parts.push(p);
    if (section.bullets)
      parts.push(section.bullets.map((b) => `- ${b}`).join("\n"));
  }
  if (page.picks) {
    parts.push("## The picks");
    page.picks.forEach((pick, i) => {
      parts.push(`### ${i + 1}. ${pick.name}`);
      parts.push(`**Best for:** ${pick.bestFor}`);
      parts.push(`**Price:** ${pick.price}`);
      if (pick.fact) parts.push(`**${pick.fact.label}:** ${pick.fact.value}`);
      for (const p of pick.paragraphs) parts.push(p);
      if (pick.link) {
        const href = pick.link.href.startsWith("/")
          ? `${site}${pick.link.href}`
          : pick.link.href;
        parts.push(`[${pick.link.label}](${href})`);
      }
    });
  }
  if (page.myPick) {
    parts.push("## Our pick");
    for (const p of page.myPick) parts.push(p);
  }
  if (page.actionSteps) {
    parts.push("## What to do today");
    parts.push(page.actionSteps.map((s, i) => `${i + 1}. ${s}`).join("\n"));
  }
  if (page.faq.length > 0) {
    parts.push("## Questions");
    for (const f of page.faq) parts.push(`**${f.q}**\n\n${f.a}`);
  }
  parts.push("## Related");
  parts.push(
    page.related
      .map(
        (r) =>
          `- [${r.label}](${r.href.startsWith("/") ? `${site}${r.href}` : r.href})`
      )
      .join("\n")
  );
  parts.push(`---\n\n*${PRICING_DISCLAIMER}*`);
  parts.push(`[${SEO_CTA.buttonLabel}](${site}${SEO_CTA.buttonHref})`);
  return parts.join("\n\n");
}
