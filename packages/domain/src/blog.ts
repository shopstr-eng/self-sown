import type { NostrEventRecord } from "./seller";

// NIP-23 long-form content. Storefront blog posts are addressable
// (parameterized replaceable) events keyed by their `d` tag.
export const BLOG_POST_KIND = 30023;

export interface BlogPost {
  id: string;
  pubkey: string;
  dTag: string;
  title: string;
  summary?: string;
  image?: string;
  /** Markdown body (NIP-23 content). Never HTML. */
  content: string;
  /** Seconds since epoch from the `published_at` tag (falls back to created_at). */
  publishedAt: number;
  /** Event created_at — the moment this version was published. */
  updatedAt: number;
  hashtags: string[];
  /** Optional validated http(s) link-out URL (NIP-23 `r` tag). */
  externalUrl?: string;
}

export interface BlogPostDraft {
  /** Stable addressable identifier. Required — the caller generates it for new posts. */
  dTag: string;
  title: string;
  summary?: string;
  image?: string;
  content: string;
  hashtags?: string[];
  externalUrl?: string;
  /** Override publish time (seconds). Defaults to the event created_at. */
  publishedAt?: number;
}

/**
 * A blog post the seller is preparing ahead of time. A `draft` is signed but
 * never broadcast to relays; a `scheduled` post is a pre-signed kind:30023 event
 * the server publishes (and optionally emails) at `scheduledAt`. Both live only
 * in our Postgres store until they go live — they never touch relays early.
 */
export interface ScheduledBlogPost {
  dTag: string;
  status: "draft" | "scheduled";
  /** Id of the pre-signed kind:30023 event that will be published. */
  eventId: string;
  /** Epoch seconds the post should publish at. Null for plain drafts. */
  scheduledAt: number | null;
  /** Whether to email this post to the audience when it publishes. */
  sendAsEmail: boolean;
  /** Parsed view of the pre-signed event (title/content/etc). */
  post: BlogPost;
  /** Last time this draft/scheduled entry was saved (epoch seconds). */
  updatedAt: number;
  /** How many times the cron has failed to publish/email this post. */
  attemptCount: number;
  /** Last failure reason recorded by the cron (null if none). */
  lastError: string | null;
  /** Epoch seconds of the last failed attempt (null if none). */
  lastAttemptAt: number | null;
}

/**
 * Strict http(s) URL guard. Buyer-rendered URLs come from permissionless,
 * attacker-controllable events, so any link-out / image URL must pass this at
 * parse time AND again at render time before it is placed in an href/src.
 */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Normalize a user-entered hashtag into a NIP-23 `t` value. */
export function normalizeHashtag(tag: string): string {
  return tag
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Build the NIP-23 tag set for a blog post. The content (markdown) is carried
 * separately on the event. Throws on missing identifier/title so a malformed
 * draft can never be published as a blank addressable event.
 */
export function buildBlogPostTags(
  draft: BlogPostDraft,
  createdAt: number
): string[][] {
  const dTag = typeof draft.dTag === "string" ? draft.dTag.trim() : "";
  if (!dTag) throw new Error("Blog post requires a stable identifier (d tag)");
  const title = typeof draft.title === "string" ? draft.title.trim() : "";
  if (!title) throw new Error("Blog post requires a title");

  const publishedAt =
    typeof draft.publishedAt === "number" && Number.isFinite(draft.publishedAt)
      ? Math.floor(draft.publishedAt)
      : createdAt;

  const tags: string[][] = [
    ["d", dTag],
    ["title", title],
    ["published_at", String(publishedAt)],
  ];

  const summary = typeof draft.summary === "string" ? draft.summary.trim() : "";
  if (summary) tags.push(["summary", summary]);

  if (isHttpUrl(draft.image)) tags.push(["image", draft.image.trim()]);

  if (Array.isArray(draft.hashtags)) {
    const seen = new Set<string>();
    for (const raw of draft.hashtags) {
      if (typeof raw !== "string") continue;
      const t = normalizeHashtag(raw);
      if (t && !seen.has(t)) {
        seen.add(t);
        tags.push(["t", t]);
      }
    }
  }

  if (isHttpUrl(draft.externalUrl)) tags.push(["r", draft.externalUrl.trim()]);

  return tags;
}

/**
 * Parse a cached/relayed kind:30023 event into a BlogPost. Returns null for
 * anything that is not a usable post (wrong kind, no identifier, no title).
 * Image and link-out URLs are http(s)-validated here so consumers never render
 * a hostile scheme.
 */
export function parseBlogPostEvent(
  event: NostrEventRecord | null | undefined
): BlogPost | null {
  if (!event || event.kind !== BLOG_POST_KIND) return null;
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const firstTag = (name: string): string | undefined => {
    const found = tags.find((t) => Array.isArray(t) && t[0] === name);
    return found && typeof found[1] === "string" ? found[1] : undefined;
  };

  const dTag = firstTag("d");
  const title = firstTag("title");
  if (!dTag || !title) return null;

  const summary = firstTag("summary");
  const imageRaw = firstTag("image");
  const publishedAtRaw = firstTag("published_at");
  const publishedAt =
    publishedAtRaw && /^\d+$/.test(publishedAtRaw)
      ? parseInt(publishedAtRaw, 10)
      : event.created_at;

  const hashtags = tags
    .filter((t) => Array.isArray(t) && t[0] === "t" && typeof t[1] === "string")
    .map((t) => t[1] as string)
    .filter((t) => t.length > 0);

  const externalUrl = tags
    .filter((t) => Array.isArray(t) && t[0] === "r")
    .map((t) => t[1])
    .find((u) => isHttpUrl(u)) as string | undefined;

  return {
    id: event.id,
    pubkey: event.pubkey,
    dTag,
    title,
    ...(summary ? { summary } : {}),
    ...(isHttpUrl(imageRaw) ? { image: imageRaw } : {}),
    content: typeof event.content === "string" ? event.content : "",
    publishedAt,
    updatedAt: event.created_at,
    hashtags,
    ...(externalUrl ? { externalUrl } : {}),
  };
}

/**
 * Collapse multiple versions of the same addressable post (same pubkey + d tag)
 * to the most recently published one, then sort newest-first by publish time.
 * Used when merging relay results with the Postgres cache.
 */
export function dedupeLatestBlogPosts(posts: BlogPost[]): BlogPost[] {
  const latest = new Map<string, BlogPost>();
  for (const post of posts) {
    const key = `${post.pubkey}:${post.dTag}`;
    const existing = latest.get(key);
    if (!existing || post.updatedAt > existing.updatedAt) {
      latest.set(key, post);
    }
  }
  return Array.from(latest.values()).sort(
    (a, b) => b.publishedAt - a.publishedAt
  );
}
