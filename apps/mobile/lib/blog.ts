import {
  buildBlogPostTags,
  dedupeLatestBlogPosts,
  isHttpUrl,
  parseBlogPostEvent,
  BLOG_POST_KIND,
  type BlogPost,
  type BlogPostDraft,
  type NostrEventRecord,
  type ScheduledBlogPost,
  type SellerSession,
} from "@self-sown/domain";
import {
  cacheSignedEvent,
  createSellerActionAuthEventTemplate,
  publishSignedEvent,
  signEventTemplate,
} from "@self-sown/nostr";

import { getApiBaseUrl } from "./api-base-url";
import { deleteCachedEvents } from "./delete-events";
import { toBase64 } from "./nip98";

// Mirrors the web blog settings contracts in pages/settings/blog.tsx and
// pages/api/storefront/blog/*, pages/api/email/broadcast-blog-post.ts. Draft
// and scheduled reads/writes authorize with a signed seller-action event
// (kind 27235, action blog-scheduled-read/-write, method/path/field binding);
// publishing signs a kind:30023 event, caches it server-side, then broadcasts
// to the seller's relays.
const BROADCAST_PATH = "/api/email/broadcast-blog-post";
const SCHEDULED_POST_PATH = "/api/storefront/blog/scheduled-post";
const SCHEDULED_POSTS_PATH = "/api/storefront/blog/scheduled-posts";
const BLOG_POSTS_PATH = "/api/storefront/blog-posts";
const SENDER_DOMAIN_PATH = "/api/email/sender-domain";
const UNSUBSCRIBE_COUNTS_PATH = "/api/email/unsubscribe-counts";

// Server-side bounds in pages/api/storefront/blog/scheduled-post.ts.
const MIN_SCHEDULE_LEAD_MS = 60 * 1000;

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function newBlogDTag(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function parseHashtags(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export interface BlogEditorDraft {
  dTag: string;
  title: string;
  summary: string;
  imageUrl: string;
  externalUrl: string;
  hashtags: string[];
  content: string;
}

// Mirrors buildValidatedDraft in pages/settings/blog.tsx: trims, requires
// title + content, and drops non-http(s) URLs before signing.
export function validateBlogEditorDraft(
  draft: BlogEditorDraft
): BlogPostDraft | string {
  const title = draft.title.trim();
  const content = draft.content.trim();
  if (!title) return "Give the post a title.";
  if (!content) return "Write the post content before saving.";
  const imageUrl = draft.imageUrl.trim();
  const externalUrl = draft.externalUrl.trim();
  if (imageUrl && !isHttpUrl(imageUrl)) {
    return "The image URL must start with http:// or https://.";
  }
  if (externalUrl && !isHttpUrl(externalUrl)) {
    return "The link URL must start with http:// or https://.";
  }
  return {
    dTag: draft.dTag,
    title,
    content,
    ...(draft.summary.trim() ? { summary: draft.summary.trim() } : {}),
    ...(imageUrl ? { image: imageUrl } : {}),
    ...(externalUrl ? { externalUrl } : {}),
    hashtags: draft.hashtags,
  };
}

export function blogDraftFromPost(post: BlogPost): BlogEditorDraft {
  return {
    dTag: post.dTag,
    title: post.title,
    summary: post.summary ?? "",
    imageUrl: post.image ?? "",
    externalUrl: post.externalUrl ?? "",
    hashtags: post.hashtags,
    content: post.content,
  };
}

export function parseScheduleInput(raw: string): number | string {
  const trimmed = raw.trim();
  if (!trimmed) return "Pick a date and time like 2026-12-31 09:00.";
  const parsed = new Date(trimmed.replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) {
    return "Schedule time must look like 2026-12-31 09:00.";
  }
  const epoch = Math.floor(parsed.getTime() / 1000);
  if (epoch * 1000 < Date.now() + MIN_SCHEDULE_LEAD_MS) {
    return "Pick a schedule time at least a minute in the future.";
  }
  return epoch;
}

export async function listBlogPosts(pubkey: string): Promise<BlogPost[]> {
  const response = await fetch(
    `${getApiBaseUrl()}${BLOG_POSTS_PATH}?pubkey=${encodeURIComponent(pubkey)}`
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Blog posts could not be loaded.")
    );
  }
  const data = (await response.json()) as unknown;
  const parsed = (Array.isArray(data) ? data : [])
    .map((event) => parseBlogPostEvent(event as NostrEventRecord))
    .filter((post): post is BlogPost => post !== null);
  return dedupeLatestBlogPosts(parsed);
}

export async function getSenderDomainValid(pubkey: string): Promise<boolean> {
  const response = await fetch(
    `${getApiBaseUrl()}${SENDER_DOMAIN_PATH}?pubkey=${encodeURIComponent(pubkey)}`
  );
  if (!response.ok) return false;
  const data = (await response.json()) as { valid?: boolean };
  return Boolean(data?.valid);
}

export interface AudienceExits {
  unsubscribed: number;
  suppressed: number;
}

export async function getAudienceExits(
  pubkey: string
): Promise<AudienceExits | null> {
  const response = await fetch(
    `${getApiBaseUrl()}${UNSUBSCRIBE_COUNTS_PATH}?pubkey=${encodeURIComponent(pubkey)}`
  );
  if (!response.ok) return null;
  const data = (await response.json()) as {
    unsubscribed?: number;
    suppressed?: number;
  };
  if (
    typeof data?.unsubscribed === "number" &&
    typeof data?.suppressed === "number"
  ) {
    return { unsubscribed: data.unsubscribed, suppressed: data.suppressed };
  }
  return null;
}

// Drafts + scheduled posts are never broadcast to relays until they go live,
// so reading them requires a signed auth event (base64 `auth` query param).
export async function listScheduledBlogPosts(
  session: SellerSession
): Promise<ScheduledBlogPost[]> {
  const signedAuth = signEventTemplate(
    session,
    createSellerActionAuthEventTemplate(session.pubkey, "blog-scheduled-read", {
      method: "GET",
      path: SCHEDULED_POSTS_PATH,
    })
  );
  const auth = toBase64(JSON.stringify(signedAuth));
  const response = await fetch(
    `${getApiBaseUrl()}${SCHEDULED_POSTS_PATH}?pubkey=${encodeURIComponent(
      session.pubkey
    )}&auth=${encodeURIComponent(auth)}`
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        "Drafts and scheduled posts could not be loaded."
      )
    );
  }
  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as ScheduledBlogPost[]) : [];
}

function signBlogPostEvent(
  session: SellerSession,
  draft: BlogPostDraft,
  createdAt?: number
) {
  const timestamp =
    typeof createdAt === "number" && Number.isFinite(createdAt)
      ? Math.floor(createdAt)
      : Math.floor(Date.now() / 1000);
  return signEventTemplate(session, {
    kind: BLOG_POST_KIND,
    created_at: timestamp,
    tags: buildBlogPostTags(draft, timestamp),
    content: draft.content,
  });
}

// Publish a post now: sign kind:30023, cache server-side, broadcast to relays.
export async function publishBlogPost(
  session: SellerSession,
  draft: BlogPostDraft
): Promise<{ eventId: string }> {
  const signed = signBlogPostEvent(session, draft);
  await cacheSignedEvent(getApiBaseUrl(), signed);
  await publishSignedEvent(session, signed);
  return { eventId: signed.id };
}

// Save a draft (scheduledAt null) or schedule a post. The pre-signed event is
// held server-side and only broadcast at publish time.
export async function saveScheduledBlogPost(
  session: SellerSession,
  draft: BlogPostDraft,
  scheduledAt: number | null,
  sendAsEmail: boolean
): Promise<void> {
  const blogEvent = signBlogPostEvent(
    session,
    draft,
    scheduledAt ?? undefined
  );
  const eventId = blogEvent.id;
  const signedEvent = signEventTemplate(
    session,
    createSellerActionAuthEventTemplate(
      session.pubkey,
      "blog-scheduled-write",
      {
        method: "POST",
        path: SCHEDULED_POST_PATH,
        fields: { dTag: draft.dTag, eventId },
      }
    )
  );
  const response = await fetch(`${getApiBaseUrl()}${SCHEDULED_POST_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pubkey: session.pubkey,
      signedEvent,
      blogEvent,
      scheduledAt,
      sendAsEmail,
    }),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "The post could not be saved.")
    );
  }
}

export async function deleteScheduledBlogPost(
  session: SellerSession,
  dTag: string
): Promise<void> {
  const signedEvent = signEventTemplate(
    session,
    createSellerActionAuthEventTemplate(
      session.pubkey,
      "blog-scheduled-write",
      { method: "DELETE", path: SCHEDULED_POST_PATH, fields: { dTag } }
    )
  );
  const response = await fetch(`${getApiBaseUrl()}${SCHEDULED_POST_PATH}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: session.pubkey, dTag, signedEvent }),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "The post could not be deleted.")
    );
  }
}

// Email a published post version to the seller's audience. Auth binds the
// exact (dTag, eventId, audienceSource) so a captured proof can't be retargeted.
// One retry on 409 mirrors the web (read-after-write settle).
export async function broadcastBlogPost(
  session: SellerSession,
  params: {
    dTag: string;
    eventId: string;
    audienceSource?: "popup" | "subscription";
  }
): Promise<string> {
  const attempt = async (): Promise<Response> => {
    const signedEvent = signEventTemplate(
      session,
      createSellerActionAuthEventTemplate(
        session.pubkey,
        "blog-broadcast-write",
        {
          method: "POST",
          path: BROADCAST_PATH,
          fields: {
            dTag: params.dTag,
            eventId: params.eventId,
            ...(params.audienceSource
              ? { audienceSource: params.audienceSource }
              : {}),
          },
        }
      )
    );
    return fetch(`${getApiBaseUrl()}${BROADCAST_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pubkey: session.pubkey,
        dTag: params.dTag,
        eventId: params.eventId,
        signedEvent,
        ...(params.audienceSource
          ? { audienceSource: params.audienceSource }
          : {}),
      }),
    });
  };

  let response = await attempt();
  if (response.status === 409) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    response = await attempt();
  }

  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    sent?: number;
    failed?: number;
    skipped?: boolean;
    reason?: string;
    total?: number;
  };
  if (!response.ok) {
    throw new Error(data.error || "The broadcast email could not be sent.");
  }
  if (data.skipped) {
    return `Email not sent: ${data.reason || "already emailed"}.`;
  }
  if (data.reason === "empty-audience") {
    return "No subscribed contacts to email.";
  }
  return `Emailed ${data.sent ?? 0} contact${data.sent === 1 ? "" : "s"}${
    data.failed ? ` (${data.failed} failed)` : ""
  }.`;
}

// Delete a live post: kind:5 to relays, then remove from the server cache.
export async function deleteBlogPost(
  session: SellerSession,
  eventId: string
): Promise<void> {
  const deleteEvent = signEventTemplate(session, {
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    content: "Self-sown deletion request",
    tags: [
      ["e", eventId],
      ["k", String(BLOG_POST_KIND)],
    ],
  });
  await publishSignedEvent(session, deleteEvent);
  await deleteCachedEvents(session, [eventId]);
}
