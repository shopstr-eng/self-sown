"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import StorefrontThemeWrapper from "@/components/storefront/storefront-theme-wrapper";
import MilkMarketSpinner from "@/components/utility-components/mm-spinner";
import BlogMarkdown from "@/components/storefront/blog/blog-markdown";
import { NostrEvent } from "@/utils/types/types";
import {
  parseBlogPostEvent,
  dedupeLatestBlogPosts,
  isHttpUrl,
  type BlogPost,
} from "@milk-market/domain";
import { getBlogPostSlug, findBlogPostBySlug } from "@/utils/url-slugs";
import {
  applyCustomDomainHref,
  useIsCustomDomain,
} from "@/utils/storefront/custom-domain-context";

interface ThemedBlogProps {
  sellerPubkey: string;
  shopSlug: string;
  postSlug?: string;
}

function formatDate(seconds: number): string {
  try {
    return new Date(seconds * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

export default function ThemedBlog({
  sellerPubkey,
  shopSlug,
  postSlug,
}: ThemedBlogProps) {
  const router = useRouter();
  const isCustomDomain = useIsCustomDomain();
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!sellerPubkey) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/storefront/blog-posts?pubkey=${encodeURIComponent(
            sellerPubkey
          )}`
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
  }, [sellerPubkey]);

  const stallHref = applyCustomDomainHref(
    `/stall/${shopSlug}`,
    shopSlug,
    isCustomDomain
  );
  const blogHref = applyCustomDomainHref(
    `/stall/${shopSlug}/blog`,
    shopSlug,
    isCustomDomain
  );

  const activePost = useMemo(() => {
    if (!postSlug) return undefined;
    return findBlogPostBySlug(postSlug, posts);
  }, [postSlug, posts]);

  const content = (() => {
    if (!loaded) {
      return (
        <div className="flex min-h-[60vh] items-center justify-center">
          <MilkMarketSpinner />
        </div>
      );
    }

    // ---- Single post view ----
    if (postSlug) {
      if (!activePost) {
        return (
          <div className="storefront-themed flex min-h-screen flex-col items-center justify-center px-6 pt-24 pb-12 text-center">
            <h1 className="text-3xl font-bold">Post not found</h1>
            <p className="mt-3 opacity-70">
              This blog post doesn&apos;t exist or has been removed.
            </p>
            <button
              type="button"
              onClick={() => router.push(blogHref)}
              className="bg-primary-blue mt-6 rounded-lg px-6 py-3 font-bold text-white"
            >
              Back to Blog
            </button>
          </div>
        );
      }

      const post = activePost;
      return (
        <article className="storefront-themed mx-auto min-h-screen max-w-3xl px-4 pt-24 pb-16 sm:px-6">
          <button
            type="button"
            onClick={() => router.push(blogHref)}
            className="font-body mb-6 text-sm font-semibold opacity-70 hover:opacity-100"
          >
            ← Back to Blog
          </button>
          <h1 className="font-heading text-3xl font-bold sm:text-4xl">
            {post.title}
          </h1>
          <p className="font-body mt-2 text-sm opacity-60">
            {formatDate(post.publishedAt)}
          </p>
          {post.hashtags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {post.hashtags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-black/5 px-3 py-1 text-xs font-semibold opacity-70"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
          {post.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={post.image}
              alt={post.title}
              className="mt-6 h-auto max-h-[28rem] w-full rounded-xl object-cover"
            />
          )}
          {post.externalUrl && isHttpUrl(post.externalUrl) && (
            <a
              href={post.externalUrl}
              target="_blank"
              rel="noopener noreferrer nofollow ugc"
              className="bg-primary-blue mt-6 inline-flex items-center gap-2 rounded-lg px-5 py-2.5 font-bold text-white transition-transform hover:-translate-y-0.5"
            >
              Read the full article →
            </a>
          )}
          <div className="mt-8">
            <BlogMarkdown content={post.content} />
          </div>
        </article>
      );
    }

    // ---- Blog index view ----
    return (
      <div className="storefront-themed mx-auto min-h-screen max-w-6xl px-4 pt-24 pb-16 sm:px-6">
        <button
          type="button"
          onClick={() => router.push(stallHref)}
          className="font-body mb-6 text-sm font-semibold opacity-70 hover:opacity-100"
        >
          ← Back to Stall
        </button>
        <h1 className="font-heading text-3xl font-bold sm:text-4xl">Blog</h1>
        {posts.length === 0 ? (
          <p className="font-body mt-6 opacity-60">No blog posts yet.</p>
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((post) => {
              const href = applyCustomDomainHref(
                `/stall/${shopSlug}/blog/${getBlogPostSlug(post, posts)}`,
                shopSlug,
                isCustomDomain
              );
              return (
                <button
                  type="button"
                  key={post.id}
                  onClick={() => router.push(href)}
                  className="flex flex-col overflow-hidden rounded-xl border-2 border-black/10 text-left transition-shadow hover:shadow-lg"
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
                    <h2 className="font-heading line-clamp-2 text-lg font-bold">
                      {post.title}
                    </h2>
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
              );
            })}
          </div>
        )}
      </div>
    );
  })();

  return (
    <StorefrontThemeWrapper sellerPubkey={sellerPubkey} renderChrome={true}>
      {content}
    </StorefrontThemeWrapper>
  );
}
