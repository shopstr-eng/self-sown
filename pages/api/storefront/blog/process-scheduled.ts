import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  claimDueScheduledBlogPosts,
  deletePublishedScheduledBlogPost,
  releaseScheduledBlogPostClaim,
  fetchBlogPostByDTagAndPubkey,
} from "@/utils/db/db-service";
import { republishBlogPostToAuthorRelays } from "@/utils/nostr/server-nostr-helpers";
import { runBlogBroadcast } from "@/utils/email/blog-broadcast";
import { isPubkeyProEntitled } from "@/utils/pro/membership";

/**
 * Cron: publish due SCHEDULED blog posts and (optionally) email them.
 *
 * For each claimed-due post the seller pre-signed client-side, we: publish the
 * kind:30023 event to the author's relays + cache it (server needs no key), then
 * — only if the post opted into email AND the seller is still Pro-entitled — run
 * the shared fail-closed/idempotent broadcast, and finally drop the scheduled
 * row. Every step is idempotent: a transient cache/email failure releases the
 * claim so the next tick retries instead of losing the post. Secured by the
 * shared FLOW_PROCESSOR_SECRET (no Nostr auth; there is no per-user caller).
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (
    !(await applyRateLimit(req, res, "blog-process-scheduled", {
      limit: 30,
      windowMs: 60_000,
    }))
  )
    return;

  const secret = req.headers["x-flow-processor-secret"] || req.body?.secret;
  const expectedSecret = process.env.FLOW_PROCESSOR_SECRET;
  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const now = Math.floor(Date.now() / 1000);
  const batchSize = Math.min(parseInt(req.body?.batch_size, 10) || 20, 20);

  let claimed;
  try {
    claimed = await claimDueScheduledBlogPosts(now, batchSize);
  } catch (error) {
    console.error("Failed to claim due scheduled blog posts:", error);
    return res.status(500).json({ error: "Failed to claim posts" });
  }

  if (claimed.length === 0) {
    return res.status(200).json({ processed: 0, results: [] });
  }

  const results: Array<{
    pubkey: string;
    dTag: string;
    status: "published" | "retry" | "error";
    published?: number;
    email?: string;
  }> = [];

  for (const row of claimed) {
    const { pubkey, d_tag: dTag, event_id: eventId, signed_event } = row;
    try {
      const { published } = await republishBlogPostToAuthorRelays(signed_event);

      // Confirm the post is actually readable in our cache before we consider
      // it published; if caching failed, retry on the next tick.
      const cached = await fetchBlogPostByDTagAndPubkey(dTag, pubkey);
      if (!cached || cached.id !== eventId) {
        await releaseScheduledBlogPostClaim(pubkey, dTag, eventId, {
          error: "Publish not confirmed in cache; will retry.",
          at: now,
        });
        results.push({ pubkey, dTag, status: "retry" });
        continue;
      }

      let emailNote: string | undefined;
      let emailTransientFailure = false;
      if (row.send_as_email) {
        if (await isPubkeyProEntitled(pubkey)) {
          const outcome = await runBlogBroadcast({ pubkey, dTag, eventId });
          emailNote = outcome.kind;
          // Only all-failed / claim-failed are worth retrying; every other
          // outcome (sent, skipped, empty-audience, ...) is terminal.
          if (
            outcome.kind === "all-failed" ||
            outcome.kind === "claim-failed"
          ) {
            emailTransientFailure = true;
          }
        } else {
          emailNote = "not-pro";
        }
      }

      if (emailTransientFailure) {
        // Post is live, but email needs another attempt — keep the row.
        await releaseScheduledBlogPostClaim(pubkey, dTag, eventId, {
          error: "Post published, but emailing it failed; will retry.",
          at: now,
        });
        results.push({
          pubkey,
          dTag,
          status: "retry",
          published,
          email: emailNote,
        });
        continue;
      }

      await deletePublishedScheduledBlogPost(pubkey, dTag, eventId);
      results.push({
        pubkey,
        dTag,
        status: "published",
        published,
        email: emailNote,
      });
    } catch (error) {
      console.error("Failed to publish scheduled blog post:", error);
      await releaseScheduledBlogPostClaim(pubkey, dTag, eventId, {
        error:
          error instanceof Error && error.message
            ? `Publishing failed: ${error.message}`
            : "Publishing failed; will retry.",
        at: now,
      }).catch(console.error);
      results.push({ pubkey, dTag, status: "error" });
    }
  }

  return res.status(200).json({
    processed: results.filter((r) => r.status === "published").length,
    results,
  });
}
