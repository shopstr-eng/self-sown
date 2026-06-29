import {
  fetchBlogPostByDTagAndPubkey,
  fetchBlogPostsByPubkeyFromDb,
  getSellerAudienceEmails,
  claimBlogBroadcast,
  releaseBlogBroadcast,
  getShopSlugByPubkey,
  type SellerAudienceSource,
} from "@/utils/db/db-service";
import { resolveSellerSenderEmail } from "@/utils/db/email-sender-domains";
import { loadStorefrontBranding } from "@/utils/email/storefront-branding";
import { sendEmailStrictFrom } from "@/utils/email/email-service";
import { buildBlogBroadcastEmail } from "@/utils/email/blog-broadcast-email";
import { buildSellerEmailUnsubscribeUrl } from "@/utils/email/unsubscribe-tokens";
import { getBlogPostSlug } from "@/utils/url-slugs";
import { parseBlogPostEvent, type BlogPost } from "@milk-market/domain";

const MAX_AUDIENCE = 5000;
const SEND_CONCURRENCY = 5;
// Conservative email-shape gate. Audience emails are already lowercased + the
// unsubscribe list is applied in SQL; this just drops anything malformed so we
// never hand garbage to SendGrid.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Discriminated outcome of a blog email broadcast. The API endpoint maps these
 * to HTTP status codes; the scheduled-publish cron consumes them directly. All
 * of the fail-closed + one-shot-idempotency logic lives here so the immediate
 * "publish now" path and the scheduled path behave identically.
 */
export type BlogBroadcastOutcome =
  | { kind: "not-cached" }
  | { kind: "version-mismatch" }
  | { kind: "invalid-post" }
  | { kind: "skipped"; reason: string }
  | { kind: "empty-audience" }
  | { kind: "claim-failed" }
  | { kind: "all-failed"; sent: number; failed: number; total: number }
  | { kind: "sent"; sent: number; failed: number; total: number };

/**
 * Email a seller's just-published blog post version to their audience.
 *
 * Fail-closed by design: the blast is sent ONLY from the seller's own verified
 * SendGrid domain-authenticated address (never the platform's global sender),
 * ONLY to the seller's server-derived audience, ONLY once per published version
 * (idempotency ledger), and every message carries a signed one-click
 * unsubscribe. Callers are responsible for proving ownership (signed auth) /
 * Pro entitlement before invoking this.
 */
export async function runBlogBroadcast(params: {
  pubkey: string;
  dTag: string;
  eventId: string;
  /**
   * Narrow the send to a single captured-contact origin (popup vs
   * subscription). Omitted = the full audience (buyers + every captured
   * contact), matching the original behavior.
   */
  audienceSource?: SellerAudienceSource;
}): Promise<BlogBroadcastOutcome> {
  const { pubkey, dTag, eventId, audienceSource } = params;

  // Re-fetch the signed post from cache; never trust client-supplied content.
  // Tie the broadcast to the exact published version via the event id.
  const postEvent = await fetchBlogPostByDTagAndPubkey(dTag, pubkey);
  if (!postEvent) {
    return { kind: "not-cached" };
  }
  if (postEvent.id !== eventId) {
    return { kind: "version-mismatch" };
  }
  const post = parseBlogPostEvent(postEvent as any);
  if (!post) {
    return { kind: "invalid-post" };
  }

  // FAIL-CLOSED: require a verified custom sender domain. We never send a
  // seller's bulk blast from the platform's global verified sender.
  const fromEmail = await resolveSellerSenderEmail(pubkey);
  if (!fromEmail) {
    return { kind: "skipped", reason: "no-verified-sender-domain" };
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://milk.market";

  // FAIL-CLOSED: an unsubscribe secret must be configured or we cannot ship a
  // working RFC 8058 unsubscribe. Probe by minting one URL (throws if unset).
  try {
    buildSellerEmailUnsubscribeUrl(baseUrl, pubkey, "probe@example.com");
  } catch {
    return { kind: "skipped", reason: "unsubscribe-unavailable" };
  }

  // Server-derived audience (buyers + popup captures), already lowercased with
  // the seller's unsubscribe list removed in SQL. Cap + de-dupe + shape-filter.
  const audience = Array.from(
    new Set(
      (await getSellerAudienceEmails(pubkey, audienceSource)).map((e) =>
        e.toLowerCase()
      )
    )
  )
    .filter((e) => EMAIL_RE.test(e))
    .slice(0, MAX_AUDIENCE);

  if (audience.length === 0) {
    return { kind: "empty-audience" };
  }

  // Idempotency: exactly one broadcast per (pubkey, dTag, eventId). Claimed only
  // AFTER every skip condition AND after confirming a non-empty audience, so an
  // empty-audience attempt never burns the one-shot claim — the seller can retry
  // this same published version once they actually have subscribers. Still
  // concurrency-safe: only the winning claim proceeds to send; a racing caller
  // gets `already-sent`.
  const claimed = await claimBlogBroadcast(pubkey, dTag, eventId);
  if (claimed === null) {
    return { kind: "claim-failed" };
  }
  if (!claimed) {
    return { kind: "skipped", reason: "already-sent" };
  }

  // Build the internal themed post URL (never the post's external link-out).
  const allPosts = (await fetchBlogPostsByPubkeyFromDb(pubkey))
    .map((e) => parseBlogPostEvent(e as any))
    .filter((p): p is BlogPost => p !== null);
  const stallSegment = (await getShopSlugByPubkey(pubkey)) || pubkey;
  const postSlug = getBlogPostSlug(post, allPosts.length ? allPosts : [post]);
  const postUrl = `${baseUrl}/stall/${encodeURIComponent(
    stallSegment
  )}/blog/${encodeURIComponent(postSlug)}`;

  const branding = await loadStorefrontBranding(pubkey);
  const shopName = branding?.shopName || "our shop";
  const style = branding?.style;

  let sent = 0;
  let failed = 0;
  const queue = [...audience];

  const worker = async () => {
    for (;;) {
      const to = queue.shift();
      if (!to) return;
      try {
        const unsubscribeUrl = buildSellerEmailUnsubscribeUrl(
          baseUrl,
          pubkey,
          to
        );
        const { subject, html } = buildBlogBroadcastEmail({
          post,
          postUrl,
          shopName,
          unsubscribeUrl,
          style,
        });
        const ok = await sendEmailStrictFrom({
          to,
          subject,
          html,
          fromEmail,
          fromName: branding?.shopName,
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });
        if (ok) sent++;
        else failed++;
      } catch (err) {
        console.error("Blog broadcast send error:", err);
        failed++;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SEND_CONCURRENCY, audience.length) }, worker)
  );

  // If NOTHING went out (e.g. SendGrid was down), release the claim so the
  // seller can retry without the version being permanently marked as sent.
  if (sent === 0 && failed > 0) {
    await releaseBlogBroadcast(pubkey, dTag, eventId);
    return { kind: "all-failed", sent, failed, total: audience.length };
  }

  return { kind: "sent", sent, failed, total: audience.length };
}
