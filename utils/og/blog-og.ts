import { OgMetaProps, DEFAULT_OG } from "@/components/og-head";
import { NostrEvent } from "@/utils/types/types";
import { parseBlogPostEvent } from "@self-sown/domain";
import { buildArticleJsonLd } from "@/utils/geo/blog-jsonld";

// Build OpenGraph meta (+ schema.org BlogPosting JSON-LD) for a single blog
// post event. Used by the themed blog post page's getServerSideProps so social
// previews + crawlers see the post's own title/summary/image. The optional
// external link-out (`r` tag) is NEVER fetched server-side — only the post's own
// cached tags/content are used.
export function eventToBlogOgMeta(
  event: NostrEvent,
  urlPath: string,
  opts: { canonicalUrl?: string; authorName?: string } = {}
): OgMetaProps {
  const post = parseBlogPostEvent(event);
  if (!post) {
    return {
      ...DEFAULT_OG,
      title: "Self-sown Blog",
      description: "Read the latest from this Self-sown stall.",
      url: urlPath,
    };
  }

  const canonical = opts.canonicalUrl || urlPath;
  let jsonLd: Record<string, unknown>[] | undefined;
  try {
    jsonLd = [
      buildArticleJsonLd(post, {
        url: canonical,
        ...(opts.authorName ? { authorName: opts.authorName } : {}),
      }),
    ];
  } catch {
    jsonLd = undefined;
  }

  return {
    title: post.title || "Self-sown Blog",
    description: post.summary || "Read this post from a Self-sown stall.",
    image: post.image || "/self-sown.png",
    url: urlPath,
    type: "article",
    ...(jsonLd ? { jsonLd } : {}),
  };
}
