import type { NextApiRequest, NextApiResponse } from "next";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { applyRateLimit } from "@/utils/rate-limit";
import { runBlogBroadcast } from "@/utils/email/blog-broadcast";

const AUTH_PATH = "/api/email/broadcast-blog-post";

/**
 * Email a seller's just-published blog post to their audience.
 *
 * Fail-closed by design: the actual send (verified-sender-domain gating,
 * server-derived audience, one-shot idempotency, signed unsubscribe) lives in
 * runBlogBroadcast, shared with the scheduled-publish cron so both paths behave
 * identically. Auth is bound to the exact (dTag, eventId) so a captured auth
 * event can't be replayed against a different post.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Coarse per-IP safety net.
  if (
    !(await applyRateLimit(req, res, "blog-broadcast-ip", {
      limit: 20,
      windowMs: 60_000,
    }))
  )
    return;

  const { pubkey, signedEvent, dTag, eventId, audienceSource } = req.body || {};

  if (!pubkey || typeof pubkey !== "string") {
    return res.status(400).json({ error: "pubkey is required" });
  }
  if (!dTag || typeof dTag !== "string") {
    return res.status(400).json({ error: "dTag is required" });
  }
  if (!eventId || typeof eventId !== "string") {
    return res.status(400).json({ error: "eventId is required" });
  }
  // Optional audience narrowing. Only the two known capture origins are
  // accepted; anything else (including "all") is rejected so a typo can't
  // silently fall back to emailing everyone.
  if (
    audienceSource !== undefined &&
    audienceSource !== "popup" &&
    audienceSource !== "subscription"
  ) {
    return res.status(400).json({ error: "Invalid audienceSource" });
  }

  // Stricter per-seller limit: broadcasts are heavy and rarely legitimate more
  // than a handful of times an hour.
  if (
    !(await applyRateLimit(
      req,
      res,
      "blog-broadcast-pubkey",
      { limit: 5, windowMs: 60 * 60_000 },
      `pk:${pubkey}`
    ))
  )
    return;

  // Prove the caller owns `pubkey` AND bind the auth to this exact published
  // version, so the same signed event can't trigger a blast for another post.
  const auth = verifyNostrAuth(
    signedEvent,
    pubkey,
    "blog-broadcast-write" as any,
    {
      method: "POST",
      path: AUTH_PATH,
      // Bind the chosen audience too, so a captured auth event can't be
      // replayed to retarget the same post at a different segment.
      fields: { dTag, eventId, ...(audienceSource ? { audienceSource } : {}) },
    } as any
  );
  if (!auth.valid) {
    return res.status(401).json({ error: auth.error || "Unauthorized" });
  }

  // Email broadcast is a Herd/Pro feature. requireProEntitlement writes the
  // 403 itself on failure.
  if (!(await requireProEntitlement(pubkey, res))) return;

  const outcome = await runBlogBroadcast({
    pubkey,
    dTag,
    eventId,
    audienceSource,
  });

  switch (outcome.kind) {
    case "not-cached":
      return res.status(409).json({
        error: "Post not cached yet — retry shortly",
        retryable: true,
      });
    case "version-mismatch":
      return res.status(409).json({
        error: "Latest post version not cached yet — retry shortly",
        retryable: true,
      });
    case "invalid-post":
      return res.status(422).json({ error: "Not a valid blog post" });
    case "skipped":
      return res.status(200).json({
        sent: 0,
        failed: 0,
        skipped: true,
        reason: outcome.reason,
      });
    case "empty-audience":
      return res.status(200).json({
        sent: 0,
        failed: 0,
        skipped: false,
        total: 0,
        reason: "empty-audience",
      });
    case "claim-failed":
      return res.status(503).json({
        error: "Could not record broadcast — please try again",
        retryable: true,
      });
    case "all-failed":
      return res.status(502).json({
        sent: outcome.sent,
        failed: outcome.failed,
        skipped: false,
        total: outcome.total,
        error: "All sends failed — please try again",
        retryable: true,
      });
    case "sent":
      return res.status(200).json({
        sent: outcome.sent,
        failed: outcome.failed,
        skipped: false,
        total: outcome.total,
      });
    default:
      return res.status(500).json({ error: "Unexpected broadcast outcome" });
  }
}
