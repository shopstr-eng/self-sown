"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import {
  StorefrontSection,
  StorefrontColorScheme,
  NostrEvent,
} from "@/utils/types/types";
import {
  parseBlogPostEvent,
  dedupeLatestBlogPosts,
  type BlogPost,
} from "@milk-market/domain";
import { getBlogPostSlug } from "@/utils/url-slugs";
import {
  applyCustomDomainHref,
  useIsCustomDomain,
} from "@/utils/storefront/custom-domain-context";
import FormattedText from "../formatted-text";

interface SectionBlogProps {
  section: StorefrontSection;
  colors: StorefrontColorScheme;
  shopPubkey: string;
  shopSlug?: string;
  isPreview?: boolean;
}

// Curate + order the posts by the section's saved refs (d-tags, falling back to
// event ids), with any uncurated posts appended in publish order.
function applyBlogOrder(posts: BlogPost[], refs?: string[]): BlogPost[] {
  if (!refs || refs.length === 0) return posts;
  const result: BlogPost[] = [];
  const used = new Set<string>();
  for (const ref of refs) {
    const match = posts.find((p) => p.dTag === ref || p.id === ref);
    if (match && !used.has(match.id)) {
      result.push(match);
      used.add(match.id);
    }
  }
  for (const p of posts) {
    if (!used.has(p.id)) result.push(p);
  }
  return result;
}

function formatDate(seconds: number): string {
  try {
    return new Date(seconds * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

export default function SectionBlog({
  section,
  colors,
  shopPubkey,
  shopSlug,
  isPreview,
}: SectionBlogProps) {
  const router = useRouter();
  const isCustomDomain = useIsCustomDomain();
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!shopPubkey) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/storefront/blog-posts?pubkey=${encodeURIComponent(shopPubkey)}`
        );
        if (!res.ok) {
          if (!cancelled) setLoaded(true);
          return;
        }
        const events = (await res.json()) as NostrEvent[];
        const parsed = (Array.isArray(events) ? events : [])
          .map((e) => parseBlogPostEvent(e))
          .filter((p): p is BlogPost => p !== null);
        if (!cancelled) {
          setPosts(dedupeLatestBlogPosts(parsed));
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shopPubkey]);

  const layout = section.blogLayout || "grid";

  const displayPosts = useMemo(() => {
    const ordered = applyBlogOrder(posts, section.blogPostIds);
    return section.blogPostLimit
      ? ordered.slice(0, section.blogPostLimit)
      : ordered;
  }, [posts, section.blogPostIds, section.blogPostLimit]);

  const slugFor = (post: BlogPost) => getBlogPostSlug(post, posts);

  const goToPost = (post: BlogPost) => {
    if (isPreview) return;
    const href = applyCustomDomainHref(
      `/stall/${shopSlug}/blog/${slugFor(post)}`,
      shopSlug,
      isCustomDomain
    );
    router.push(href);
  };

  // Nothing to show: stay quiet on the live storefront, but give sellers a hint
  // inside the editor preview so an empty blog section doesn't look broken.
  if (loaded && displayPosts.length === 0) {
    if (!isPreview) return null;
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-16 text-center">
        {section.heading && (
          <h2
            className="font-heading mb-2 text-2xl font-bold sm:text-3xl"
            style={{ color: "var(--sf-text)" }}
          >
            {section.heading}
          </h2>
        )}
        <p className="font-body text-sm opacity-60">
          No blog posts yet. Publish a post to see it here.
        </p>
      </div>
    );
  }

  const featured = layout === "featured" ? displayPosts[0] : null;
  const rest = layout === "featured" ? displayPosts.slice(1) : displayPosts;

  return (
    <div
      className="mx-auto box-border w-full max-w-6xl min-w-0 px-3 py-16 sm:px-4 md:px-6"
      style={{ maxWidth: "100vw" }}
    >
      {section.heading && (
        <h2
          className="font-heading mb-4 max-w-full min-w-0 text-2xl font-bold break-words sm:text-3xl"
          style={{
            color: section.headingColor || "var(--sf-text)",
            overflowWrap: "anywhere",
            wordBreak: "break-word",
          }}
        >
          {section.heading}
        </h2>
      )}
      {section.subheading && (
        <p
          className="font-body mb-8 max-w-full min-w-0 text-base break-words opacity-70 sm:text-lg"
          style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
        >
          {section.subheading}
        </p>
      )}
      {section.body && (
        <FormattedText
          as="div"
          text={section.body}
          className="font-body mb-8 max-w-3xl whitespace-pre-line opacity-80"
        />
      )}

      {featured && (
        <button
          type="button"
          onClick={() => goToPost(featured)}
          className="group mb-8 block w-full overflow-hidden rounded-xl border-2 text-left transition-shadow hover:shadow-lg"
          style={{ borderColor: colors.primary + "33" }}
        >
          <div className="md:flex">
            {featured.image && (
              <div className="md:w-1/2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={featured.image}
                  alt={featured.title}
                  className="h-64 w-full object-cover md:h-full"
                />
              </div>
            )}
            <div className="flex flex-col justify-center p-8 md:w-1/2">
              <span
                className="mb-2 text-sm font-semibold tracking-wider uppercase"
                style={{ color: colors.accent }}
              >
                Latest
              </span>
              <h3 className="font-heading text-2xl font-bold md:text-3xl">
                {featured.title}
              </h3>
              {featured.summary && (
                <p className="font-body mt-3 opacity-70">{featured.summary}</p>
              )}
              <span className="font-body mt-4 text-sm opacity-50">
                {formatDate(featured.publishedAt)}
              </span>
            </div>
          </div>
        </button>
      )}

      {rest.length > 0 && (
        <div
          className={
            layout === "list"
              ? "mx-auto max-w-3xl space-y-4"
              : "grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"
          }
        >
          {rest.map((post) =>
            layout === "list" ? (
              <button
                type="button"
                key={post.id}
                onClick={() => goToPost(post)}
                className="flex w-full gap-4 overflow-hidden rounded-xl border-2 p-4 text-left transition-shadow hover:shadow-md"
                style={{ borderColor: colors.primary + "22" }}
              >
                {post.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={post.image}
                    alt={post.title}
                    className="h-24 w-24 flex-shrink-0 rounded-lg object-cover"
                  />
                )}
                <div className="flex flex-1 flex-col justify-center">
                  <h3 className="font-heading text-base font-bold">
                    {post.title}
                  </h3>
                  {post.summary && (
                    <p className="font-body mt-1 line-clamp-2 text-sm opacity-60">
                      {post.summary}
                    </p>
                  )}
                  <span className="font-body mt-2 text-xs opacity-50">
                    {formatDate(post.publishedAt)}
                  </span>
                </div>
              </button>
            ) : (
              <button
                type="button"
                key={post.id}
                onClick={() => goToPost(post)}
                className="flex flex-col overflow-hidden rounded-xl border-2 text-left transition-shadow hover:shadow-lg"
                style={{ borderColor: colors.primary + "22" }}
              >
                {post.image && (
                  <div className="aspect-video overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={post.image}
                      alt={post.title}
                      className="h-full w-full object-cover transition-transform hover:scale-105"
                    />
                  </div>
                )}
                <div className="flex flex-1 flex-col p-4">
                  <h3 className="font-heading line-clamp-2 text-base font-bold">
                    {post.title}
                  </h3>
                  {post.summary && (
                    <p className="font-body mt-1 line-clamp-3 flex-1 text-sm opacity-60">
                      {post.summary}
                    </p>
                  )}
                  <span className="font-body mt-3 text-xs opacity-50">
                    {formatDate(post.publishedAt)}
                  </span>
                </div>
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
