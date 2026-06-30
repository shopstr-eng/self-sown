// Machine-readable representations of an individual seller's stall/storefront,
// tailored to that shop. Used for content negotiation on custom domains and
// platform /stall/<slug> routes: when an LLM/agent asks for a non-HTML
// representation (Accept header or known LLM crawler), it gets this structured,
// shop-specific content instead of the HTML app shell. Browsers and SEO/social
// bots keep getting HTML so OpenGraph/SSR behaviour is untouched.

const PLATFORM = "https://milk.market";

export interface StallProductSummary {
  title: string;
  slug: string;
  price: number | null;
  currency: string;
  summary: string;
  image: string;
}

export interface StallBlogSummary {
  title: string;
  /** Readable post slug used in /blog/<slug> (already collision-resolved). */
  slug: string;
  summary: string;
  image: string;
  /** Publish time in seconds since epoch (NIP-23 published_at). */
  publishedAt: number;
}

export interface StallContentInput {
  /** Resolved display name of the shop. */
  shopName: string;
  /** Resolved "about" / description text (may be empty). */
  about: string;
  /** OG/preview image URL (may be empty). */
  image: string;
  /** Friendly stall slug. */
  slug: string;
  /**
   * Canonical base URL for THIS stall. On a custom domain this is
   * `https://<host>`; on the platform it is `https://milk.market/stall/<slug>`.
   */
  siteUrl: string;
  /** Whether this stall is served from a seller's own custom domain. */
  isCustomDomain: boolean;
  /** Recent products for this shop (already filtered + parsed). */
  products: StallProductSummary[];
  /** Published blog posts (NIP-23) for this shop, newest-first. */
  blogPosts: StallBlogSummary[];
}

export interface StallPageContent {
  title: string;
  description: string;
  markdown: string;
}

/** A single blog post (NIP-23) rendered in full for agents/LLMs. */
export interface StallPostDetail {
  title: string;
  /** Readable post slug used in /blog/<slug> (already collision-resolved). */
  slug: string;
  summary: string;
  image: string;
  /** Markdown body (NIP-23 content). Never HTML. */
  content: string;
  /** Publish time in seconds since epoch (NIP-23 published_at). */
  publishedAt: number;
  /** Last-updated time in seconds since epoch (event created_at). */
  updatedAt: number;
  hashtags: string[];
  /** Optional validated http(s) link-out URL (already http(s)-checked). */
  externalUrl?: string;
}

export interface StallPostInput {
  /** Resolved display name of the shop. */
  shopName: string;
  /** Friendly stall slug. */
  slug: string;
  /**
   * Canonical base URL for THIS stall. On a custom domain this is
   * `https://<host>`; on the platform it is `https://milk.market/stall/<slug>`.
   */
  siteUrl: string;
  /** Whether this stall is served from a seller's own custom domain. */
  isCustomDomain: boolean;
  /** The single post being rendered, in full. */
  post: StallPostDetail;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function listingUrl(input: StallContentInput, slug: string): string {
  // Listings render on both the platform and (via passthrough) custom domains,
  // so prefer the stall's own origin when it has one.
  const base = input.isCustomDomain ? new URL(input.siteUrl).origin : PLATFORM;
  return `${base}/listing/${slug}`;
}

function blogUrl(input: StallContentInput, slug: string): string {
  // Blog posts are stall-scoped: on a custom domain they live at
  // `<host>/blog/<slug>`; on the platform at `<siteUrl>/blog/<slug>` which is
  // already `https://milk.market/stall/<slug>/blog/<slug>`.
  return `${input.siteUrl}/blog/${encodeURIComponent(slug)}`;
}

function priceLabel(p: StallProductSummary): string {
  if (p.price == null) return "";
  return ` · ${p.price}${p.currency ? " " + p.currency : ""}`;
}

function description(input: StallContentInput): string {
  if (input.about) {
    return input.about.length > 200
      ? input.about.slice(0, 197) + "..."
      : input.about;
  }
  return `${input.shopName} sells local food and goods directly to buyers on Milk Market, a permissionless Bitcoin-native marketplace built on Nostr.`;
}

/** Tailored markdown for a stall homepage. */
export function buildStallMarkdown(input: StallContentInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.shopName}`);
  lines.push("");
  lines.push(description(input));
  lines.push("");

  if (input.products.length > 0) {
    lines.push("## Products");
    for (const p of input.products) {
      const url = listingUrl(input, p.slug);
      const summary = p.summary ? ` · ${p.summary}` : "";
      lines.push(`- [${p.title}](${url})${priceLabel(p)}${summary}`);
    }
    lines.push("");
  }

  if (input.blogPosts.length > 0) {
    lines.push("## Blog");
    for (const post of input.blogPosts) {
      const url = blogUrl(input, post.slug);
      const summary = post.summary ? ` · ${post.summary}` : "";
      lines.push(`- [${post.title}](${url})${summary}`);
    }
    lines.push("");
  }

  lines.push("## Payments");
  lines.push(
    "Bitcoin over the Lightning Network, Cashu ecash, cards (Stripe or Square), and manual fiat."
  );
  lines.push("");
  lines.push("## For AI agents");
  lines.push(
    `This shop is part of Milk Market. Browse and buy programmatically via the Model Context Protocol server at \`${PLATFORM}/api/mcp\`. Paid endpoints support the L402 standard. See ${PLATFORM}/.well-known/l402.json.`
  );
  lines.push("");
  lines.push(
    `Storefront: ${input.siteUrl} · Marketplace: ${PLATFORM}/marketplace`
  );
  return lines.join("\n");
}

/** Tailored JSON for a stall homepage. */
export function buildStallJson(
  input: StallContentInput
): Record<string, unknown> {
  return {
    shop: input.shopName,
    slug: input.slug,
    description: description(input),
    url: input.siteUrl,
    image: input.image || undefined,
    products: input.products.map((p) => ({
      title: p.title,
      url: listingUrl(input, p.slug),
      price: p.price ?? undefined,
      currency: p.price != null ? p.currency : undefined,
      summary: p.summary || undefined,
      image: p.image || undefined,
    })),
    posts: input.blogPosts.map((post) => ({
      title: post.title,
      url: blogUrl(input, post.slug),
      summary: post.summary || undefined,
      image: post.image || undefined,
      publishedAt: post.publishedAt || undefined,
    })),
    payments: ["lightning", "cashu", "stripe", "fiat"],
    agents: {
      mcp: `${PLATFORM}/api/mcp`,
      l402: `${PLATFORM}/.well-known/l402.json`,
      marketplace: `${PLATFORM}/marketplace`,
    },
  };
}

/** Plain-text rendering derived from the markdown. */
export function buildStallText(input: StallContentInput): string {
  return buildStallMarkdown(input)
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .trim();
}

/** Tailored llms.txt for a stall (Answer.AI llms.txt convention). */
export function buildStallLlmsTxt(input: StallContentInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.shopName}`);
  lines.push("");
  lines.push(`> ${description(input)}`);
  lines.push("");

  if (input.products.length > 0) {
    lines.push("## Products");
    for (const p of input.products) {
      const url = listingUrl(input, p.slug);
      const note = p.summary || `Product from ${input.shopName}`;
      lines.push(`- [${p.title}${priceLabel(p)}](${url}): ${note}`);
    }
    lines.push("");
  }

  if (input.blogPosts.length > 0) {
    lines.push("## Posts");
    for (const post of input.blogPosts) {
      const url = blogUrl(input, post.slug);
      const note = post.summary || `Blog post from ${input.shopName}`;
      lines.push(`- [${post.title}](${url}): ${note}`);
    }
    lines.push("");
  }

  lines.push("## Shop");
  lines.push(
    `- [Storefront](${input.siteUrl}): Browse and buy from ${input.shopName}.`
  );
  lines.push("");
  lines.push("## For AI Agents");
  lines.push(
    `- [MCP discovery](${PLATFORM}/.well-known/mcp.json): Model Context Protocol endpoint for programmatic browsing and purchasing.`
  );
  lines.push(
    `- [L402 discovery](${PLATFORM}/.well-known/l402.json): Pay-per-request standard for paid endpoints (HTTP 402).`
  );
  lines.push(
    `- [Agent policies](${PLATFORM}/agents.txt): Allowed actions, rate limits, and access rules.`
  );
  lines.push("");
  lines.push("## Optional");
  lines.push(
    `- [Feed (RSS)](${input.siteUrl}/rss.xml): Recent blog posts and products from this shop.`
  );
  return lines.join("\n");
}

/** Tailored robots.txt for a stall on its own custom domain. */
export function buildStallRobotsTxt(input: StallContentInput): string {
  const origin = input.isCustomDomain
    ? new URL(input.siteUrl).origin
    : input.siteUrl;
  return `# ${input.shopName} (powered by Milk Market)
User-agent: *
Allow: /

# AI assistants and agents are welcome to read this storefront.
User-agent: GPTBot
Allow: /
User-agent: ChatGPT-User
Allow: /
User-agent: OAI-SearchBot
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: anthropic-ai
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Google-Extended
Allow: /

LLM: ${origin}/llms.txt
Sitemap: ${origin}/sitemap.xml
`;
}

/** Tailored XML sitemap for a stall on its own custom domain. */
export function buildStallSitemap(input: StallContentInput): string {
  const origin = input.isCustomDomain
    ? new URL(input.siteUrl).origin
    : input.siteUrl;
  const currentDate = new Date().toISOString().split("T")[0];

  const urls: { loc: string; changefreq: string; priority: string }[] = [];

  urls.push({ loc: `${origin}/`, changefreq: "daily", priority: "1.0" });

  for (const product of input.products) {
    urls.push({
      loc: `${origin}/listing/${encodeURIComponent(product.slug)}`,
      changefreq: "weekly",
      priority: "0.8",
    });
  }

  // Blog posts live under /blog/<slug> on this stall's own origin (the proxy
  // rewrites a custom domain's /blog/<slug> back to /stall/<slug>/blog/<slug>).
  for (const post of input.blogPosts) {
    urls.push({
      loc: `${origin}/blog/${encodeURIComponent(post.slug)}`,
      changefreq: "monthly",
      priority: "0.6",
    });
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${currentDate}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`
  )
  .join("\n")}
</urlset>`;
}

/**
 * Tailored RSS feed for a stall. Blog posts (NIP-23) come first as dated
 * articles, followed by the shop's products, so a single per-storefront feed
 * surfaces both. Subscribers polling `<host>/rss.xml` (or `/feed.xml`) discover
 * new posts. The optional external link-out is never followed — items always
 * link to the post's own internal /blog/<slug> page.
 */
export function buildStallRss(input: StallContentInput): string {
  const blogItems = input.blogPosts
    .map((post) => {
      const link = blogUrl(input, post.slug);
      const title = escapeXml(post.title || "Untitled post");
      const desc = escapeXml(
        post.summary || `A blog post from ${input.shopName} on Milk Market.`
      );
      const pubDate = `\n      <pubDate>${new Date(
        post.publishedAt * 1000
      ).toUTCString()}</pubDate>`;
      const image = post.image
        ? `\n      <enclosure url="${escapeXml(post.image)}" type="image/jpeg" />`
        : "";
      return `    <item>
      <title>${title}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>${pubDate}
      <description>${desc}</description>${image}
    </item>`;
    })
    .join("\n");

  const productItems = input.products
    .map((p) => {
      const link = listingUrl(input, p.slug);
      const title = escapeXml(p.title || "Untitled listing");
      const priceInfo =
        p.price != null
          ? ` (${p.price}${p.currency ? " " + escapeXml(p.currency) : ""})`
          : "";
      const desc = escapeXml(
        p.summary || `A product from ${input.shopName} on Milk Market.`
      );
      const image = p.image
        ? `\n      <enclosure url="${escapeXml(p.image)}" type="image/jpeg" />`
        : "";
      return `    <item>
      <title>${title}${priceInfo}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(p.slug)}</guid>
      <description>${desc}</description>${image}
    </item>`;
    })
    .join("\n");

  const items = [blogItems, productItems]
    .filter((s) => s.length > 0)
    .join("\n");

  const lastBuild = new Date().toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(input.shopName)}</title>
    <link>${escapeXml(input.siteUrl)}</link>
    <atom:link href="${escapeXml(input.siteUrl)}/rss.xml" rel="self" type="application/rss+xml" />
    <description>${escapeXml(description(input))}</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <ttl>60</ttl>
${items}
  </channel>
</rss>`;
}

// --- Single blog post (NIP-23) machine-readable representations ---------------
// Served via content negotiation on /blog/<slug> so agents/LLMs get the full
// article body directly instead of having to render the HTML page. The post's
// fields come from a permissionless, attacker-controllable event, so:
//   - The image + external link-out URLs are already http(s)-validated upstream
//     (parseBlogPostEvent) before reaching here.
//   - The JSON representation relies on JSON serialization to escape hostile
//     field values; the markdown/text/llms representations are served with
//     non-HTML content types (text/markdown, text/plain) so embedded markup is
//     inert (never interpreted as HTML).
// The body is NIP-23 markdown authored by the seller and is emitted as-is.

/** Canonical public URL of a single post on this stall. */
function postUrl(input: StallPostInput): string {
  return `${input.siteUrl}/blog/${encodeURIComponent(input.post.slug)}`;
}

/** Short ISO date (YYYY-MM-DD) for a post timestamp in seconds. */
function postDate(seconds: number): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toISOString().split("T")[0] || "";
}

/** Full markdown rendering of a single blog post, including its body. */
export function buildPostMarkdown(input: StallPostInput): string {
  const p = input.post;
  const lines: string[] = [];
  lines.push(`# ${p.title}`);
  lines.push("");
  if (p.summary) {
    lines.push(`> ${p.summary}`);
    lines.push("");
  }
  const meta: string[] = [`By ${input.shopName}`];
  const published = postDate(p.publishedAt);
  if (published) meta.push(`Published ${published}`);
  lines.push(`*${meta.join(" · ")}*`);
  lines.push("");
  if (p.hashtags.length > 0) {
    lines.push(p.hashtags.map((t) => `#${t}`).join(" "));
    lines.push("");
  }
  if (p.image) {
    lines.push(`![${p.title}](${p.image})`);
    lines.push("");
  }
  lines.push(p.content || "_This post has no content._");
  lines.push("");
  if (p.externalUrl) {
    lines.push(`[Read more](${p.externalUrl})`);
    lines.push("");
  }
  lines.push("---");
  lines.push(
    `Post: ${postUrl(input)} · More from ${input.shopName}: ${input.siteUrl}`
  );
  return lines.join("\n");
}

/** Structured JSON for a single blog post, including its body. */
export function buildPostJson(input: StallPostInput): Record<string, unknown> {
  const p = input.post;
  return {
    type: "article",
    shop: input.shopName,
    slug: input.slug,
    url: postUrl(input),
    post: {
      title: p.title,
      slug: p.slug,
      summary: p.summary || undefined,
      image: p.image || undefined,
      content: p.content,
      publishedAt: p.publishedAt || undefined,
      updatedAt: p.updatedAt || undefined,
      hashtags: p.hashtags.length > 0 ? p.hashtags : undefined,
      externalUrl: p.externalUrl || undefined,
    },
    agents: {
      mcp: `${PLATFORM}/api/mcp`,
      l402: `${PLATFORM}/.well-known/l402.json`,
      marketplace: `${PLATFORM}/marketplace`,
    },
  };
}

/** Plain-text rendering of a single post, derived from its markdown. */
export function buildPostText(input: StallPostInput): string {
  return buildPostMarkdown(input)
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .trim();
}

/** llms.txt-style rendering of a single post, including its body. */
export function buildPostLlmsTxt(input: StallPostInput): string {
  const p = input.post;
  const lines: string[] = [];
  lines.push(`# ${p.title}`);
  lines.push("");
  if (p.summary) {
    lines.push(`> ${p.summary}`);
    lines.push("");
  }
  const meta: string[] = [`By ${input.shopName}`];
  const published = postDate(p.publishedAt);
  if (published) meta.push(`Published ${published}`);
  lines.push(meta.join(" · "));
  lines.push("");
  lines.push("## Article");
  lines.push("");
  lines.push(p.content || "_This post has no content._");
  lines.push("");
  if (p.externalUrl) {
    lines.push("## Link");
    lines.push(`- [External link](${p.externalUrl})`);
    lines.push("");
  }
  lines.push("## Shop");
  lines.push(
    `- [Storefront](${input.siteUrl}): Browse and buy from ${input.shopName}.`
  );
  lines.push(`- [This post](${postUrl(input)})`);
  lines.push("");
  lines.push("## For AI Agents");
  lines.push(
    `- [MCP discovery](${PLATFORM}/.well-known/mcp.json): Model Context Protocol endpoint for programmatic browsing and purchasing.`
  );
  lines.push(
    `- [L402 discovery](${PLATFORM}/.well-known/l402.json): Pay-per-request standard for paid endpoints (HTTP 402).`
  );
  return lines.join("\n");
}
