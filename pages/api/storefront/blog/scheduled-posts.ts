import type { NextApiRequest, NextApiResponse } from "next";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";
import { applyRateLimit } from "@/utils/rate-limit";
import { listScheduledBlogPosts } from "@/utils/db/db-service";
import {
  parseBlogPostEvent,
  type ScheduledBlogPost,
} from "@milk-market/domain";

const AUTH_PATH = "/api/storefront/blog/scheduled-posts";

/**
 * List a seller's OWN drafts + scheduled posts. These are unpublished (never
 * broadcast to relays), so the read is gated by a signed auth event proving
 * ownership of the pubkey — passed as a base64url `auth` query param since GET
 * has no body. Returns the parsed post plus its draft/scheduled metadata.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (
    !(await applyRateLimit(req, res, "blog-scheduled-read", {
      limit: 120,
      windowMs: 60_000,
    }))
  )
    return;

  const { pubkey, auth } = req.query;
  if (!pubkey || typeof pubkey !== "string") {
    return res.status(400).json({ error: "pubkey is required" });
  }
  if (!auth || typeof auth !== "string") {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let signedEvent: unknown;
  try {
    signedEvent = JSON.parse(Buffer.from(auth, "base64").toString("utf8"));
  } catch {
    return res.status(401).json({ error: "Malformed auth" });
  }

  const verified = verifyNostrAuth(
    signedEvent,
    pubkey,
    "blog-scheduled-read" as any,
    { method: "GET", path: AUTH_PATH } as any
  );
  if (!verified.valid) {
    return res.status(401).json({ error: verified.error || "Unauthorized" });
  }

  const rows = await listScheduledBlogPosts(pubkey);
  const out: ScheduledBlogPost[] = [];
  for (const row of rows) {
    const post = parseBlogPostEvent(row.signed_event as any);
    if (!post) continue;
    out.push({
      dTag: row.d_tag,
      status: row.status,
      eventId: row.event_id,
      scheduledAt: row.scheduled_at,
      sendAsEmail: row.send_as_email,
      post,
      updatedAt: row.updated_at,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      lastAttemptAt: row.last_attempt_at,
    });
  }

  return res.status(200).json(out);
}
