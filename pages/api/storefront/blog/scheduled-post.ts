import type { NextApiRequest, NextApiResponse } from "next";
import { verifyEvent } from "nostr-tools";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  upsertScheduledBlogPost,
  deleteScheduledBlogPost,
} from "@/utils/db/db-service";
import { parseBlogPostEvent } from "@milk-market/domain";

const AUTH_PATH = "/api/storefront/blog/scheduled-post";
// A scheduled time must be at least this far out (avoids "schedule" that is
// really "publish now but slower") and no further than a year ahead.
const MIN_LEAD_SECONDS = 30;
const MAX_LEAD_SECONDS = 365 * 24 * 60 * 60;

/**
 * Create / update / delete a seller's DRAFT or SCHEDULED blog post.
 *
 * Drafts and scheduled posts are pre-signed kind:30023 events that are NOT
 * broadcast to relays here — they live only in our store until publish /
 * scheduled-publish time (see process-scheduled cron). Saving is a Herd/Pro
 * "prepare ahead" feature (Pro-gated); the signed event proves the caller owns
 * the post pubkey and binds the auth to the exact (dTag, eventId).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST" && req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (
    !(await applyRateLimit(req, res, "blog-scheduled-write-ip", {
      limit: 30,
      windowMs: 60_000,
    }))
  )
    return;

  const { pubkey, signedEvent } = req.body || {};
  if (!pubkey || typeof pubkey !== "string") {
    return res.status(400).json({ error: "pubkey is required" });
  }

  if (
    !(await applyRateLimit(
      req,
      res,
      "blog-scheduled-write-pubkey",
      { limit: 60, windowMs: 60 * 60_000 },
      `pk:${pubkey}`
    ))
  )
    return;

  if (req.method === "DELETE") {
    const { dTag } = req.body || {};
    if (!dTag || typeof dTag !== "string") {
      return res.status(400).json({ error: "dTag is required" });
    }
    const auth = verifyNostrAuth(
      signedEvent,
      pubkey,
      "blog-scheduled-write" as any,
      {
        method: "DELETE",
        path: AUTH_PATH,
        fields: { dTag },
      } as any
    );
    if (!auth.valid) {
      return res.status(401).json({ error: auth.error || "Unauthorized" });
    }
    const deleted = await deleteScheduledBlogPost(pubkey, dTag);
    return res.status(200).json({ deleted });
  }

  // POST = save (create or replace).
  const { blogEvent, scheduledAt, sendAsEmail } = req.body || {};

  if (!blogEvent || typeof blogEvent !== "object") {
    return res.status(400).json({ error: "blogEvent is required" });
  }
  // The pre-signed event must be a self-authenticating kind:30023 owned by the
  // caller. verifyEvent checks id + signature.
  if (blogEvent.kind !== 30023) {
    return res
      .status(400)
      .json({ error: "blogEvent must be a kind:30023 post" });
  }
  if (blogEvent.pubkey !== pubkey) {
    return res.status(400).json({ error: "blogEvent pubkey mismatch" });
  }
  if (!verifyEvent(blogEvent)) {
    return res.status(400).json({ error: "blogEvent signature invalid" });
  }

  const post = parseBlogPostEvent(blogEvent);
  if (!post) {
    return res.status(422).json({ error: "Not a valid blog post" });
  }

  const eventId = blogEvent.id as string;
  const dTag = post.dTag;

  let status: "draft" | "scheduled" = "draft";
  let scheduled: number | null = null;
  if (scheduledAt !== null && scheduledAt !== undefined) {
    if (typeof scheduledAt !== "number" || !Number.isFinite(scheduledAt)) {
      return res.status(400).json({ error: "scheduledAt must be a number" });
    }
    const now = Math.floor(Date.now() / 1000);
    const when = Math.floor(scheduledAt);
    if (when < now + MIN_LEAD_SECONDS) {
      return res
        .status(400)
        .json({ error: "scheduledAt must be in the future" });
    }
    if (when > now + MAX_LEAD_SECONDS) {
      return res
        .status(400)
        .json({ error: "scheduledAt is too far in the future" });
    }
    status = "scheduled";
    scheduled = when;
  }

  // Bind the auth to the exact post + version so a captured auth event can't be
  // replayed to plant a different draft.
  const auth = verifyNostrAuth(
    signedEvent,
    pubkey,
    "blog-scheduled-write" as any,
    {
      method: "POST",
      path: AUTH_PATH,
      fields: { dTag, eventId },
    } as any
  );
  if (!auth.valid) {
    return res.status(401).json({ error: auth.error || "Unauthorized" });
  }

  // Saving drafts / scheduled posts is a Herd/Pro feature. Writes the 403 itself.
  if (!(await requireProEntitlement(pubkey, res))) return;

  const ok = await upsertScheduledBlogPost({
    pubkey,
    dTag,
    status,
    eventId,
    signedEvent: blogEvent,
    scheduledAt: scheduled,
    sendAsEmail: !!sendAsEmail,
    title: post.title,
    summary: post.summary ?? null,
  });

  if (!ok) {
    return res.status(500).json({ error: "Failed to save post" });
  }

  return res.status(200).json({ ok: true, status, dTag, eventId });
}
