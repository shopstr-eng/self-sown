import type { BlogPost } from "@milk-market/domain";

/**
 * schema.org BlogPosting JSON-LD for a single blog post, built server-side in
 * getServerSideProps and rendered in <head> via DynamicHead (routed through
 * `safeJsonLdString`). Mirrors the conservative approach in product-jsonld.ts —
 * we only emit fields we can state truthfully from the post's own tags/content.
 */
const SCHEMA_CONTEXT = "https://schema.org";

export function buildArticleJsonLd(
  post: BlogPost,
  opts: { url: string; authorName?: string }
): Record<string, unknown> {
  const node: Record<string, unknown> = {
    "@context": SCHEMA_CONTEXT,
    "@type": "BlogPosting",
    headline: post.title,
    url: opts.url,
    mainEntityOfPage: opts.url,
    datePublished: new Date(post.publishedAt * 1000).toISOString(),
    dateModified: new Date(post.updatedAt * 1000).toISOString(),
  };

  if (post.summary) node.description = post.summary;
  if (post.image) node.image = [post.image];
  if (opts.authorName) {
    node.author = { "@type": "Person", name: opts.authorName };
  }
  if (post.hashtags.length > 0) node.keywords = post.hashtags.join(", ");

  return node;
}
