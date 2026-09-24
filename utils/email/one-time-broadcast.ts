// One-off (non-flow) seller emails, built for the MCP agent tools: a test
// send to a single address, and a one-time broadcast to the seller's
// server-derived audience.
//
// The broadcast mirrors the blog broadcast's fail-closed posture: sent ONLY
// from the seller's own verified SendGrid domain-authenticated address (never
// the platform's global sender), ONLY to the server-derived audience with the
// unsubscribe list applied in SQL, with a signed one-click unsubscribe on
// every message.
//
// Idempotency design (two keys, two jobs):
//  - The CONTENT KEY (hash of subject+body+audience) keys the per-recipient
//    delivery ledger. A retry with a NEW agent idempotency key but identical
//    content still cannot re-email anyone, and a retry after a partial
//    failure resumes only the undelivered recipients.
//  - The CLAIM KEY (agent key if supplied, else the content key) is a row in
//    one_time_broadcast_claims used for the daily cap and first-send/retry
//    reporting, taken atomically with the cap check.
// A recipient claim is released only on a DEFINITE provider rejection (4xx);
// an ambiguous failure (timeout/5xx, where SendGrid may have accepted the
// message) keeps the claim, keeping delivery at-most-once.
//
// Callers are responsible for proving ownership (signed auth / API key) and
// Pro entitlement before invoking this — same contract as runBlogBroadcast.

import { createHash } from "crypto";
import {
  getSellerAudienceEmails,
  claimOneTimeBroadcastWithCap,
  releaseOneTimeBroadcast,
  getOneTimeBroadcastRecipients,
  claimOneTimeBroadcastRecipient,
  releaseOneTimeBroadcastRecipient,
  unsubscribeSellerEmail,
  isSellerEmailUnsubscribedStrict,
  type SellerAudienceSource,
} from "@/utils/db/db-service";
import { resolveSellerSenderEmail } from "@/utils/db/email-sender-domains";
import { loadStorefrontBranding } from "@/utils/email/storefront-branding";
import {
  sendEmail,
  sendEmailStrictFromDetailed,
} from "@/utils/email/email-service";
import {
  renderFlowEmail,
  type FlowEmailStorefrontStyle,
} from "@/utils/email/flow-email-templates";
import { buildSellerEmailUnsubscribeUrl } from "@/utils/email/unsubscribe-tokens";
import { getSiteUrl } from "@/utils/site-url";

const MAX_AUDIENCE = 5000;
const SEND_CONCURRENCY = 5;
// Blunt backstops against agent loops. Broadcasts are deliberately rare; test
// sends go through the platform sender, so cap distinct contents per day.
const BROADCAST_DAILY_LIMIT = 10;
const TEST_DAILY_LIMIT = 25;
const BROADCAST_KEY_PREFIX = "bcast:";
const TEST_KEY_PREFIX = "test:";
// Audience emails are already lowercased + unsubscribe-filtered in SQL; this
// just drops anything malformed so we never hand garbage to SendGrid.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type OneTimeBroadcastOutcome =
  | { kind: "no-sender" }
  | { kind: "unsubscribe-unavailable" }
  | { kind: "daily-limit" }
  | { kind: "key-mismatch" }
  | { kind: "empty-audience" }
  | { kind: "claim-failed" }
  | { kind: "already-sent" }
  | { kind: "all-failed"; sent: number; failed: number; total: number }
  | { kind: "sent"; sent: number; failed: number; total: number };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function contentHash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function buildOneTimeEmail(params: {
  subject: string;
  bodyHtml: string;
  shopName: string;
  unsubscribeUrl: string;
  style?: FlowEmailStorefrontStyle;
}): { subject: string; html: string } {
  const footer =
    `<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0;" />` +
    `<p style="font-size:12px;color:#666;">You received this email because ` +
    `you bought from or subscribed to ${escapeHtml(params.shopName)}. ` +
    `<a href="${params.unsubscribeUrl}">Unsubscribe</a></p>`;
  return renderFlowEmail(
    params.subject,
    params.bodyHtml + footer,
    { shop_name: params.shopName },
    params.style
  );
}

/**
 * Send a one-time broadcast to the seller's audience (or one capture-source
 * segment). Idempotent per content: a retry with the same idempotency key —
 * or identical subject/body/audience under any key — resumes only the
 * recipients not yet delivered and reports already-sent when all were
 * reached. Never throws into the caller for provider failures; DB outages
 * surface as claim-failed.
 */
export async function runOneTimeBroadcast(params: {
  pubkey: string;
  subject: string;
  bodyHtml: string;
  audienceSource?: SellerAudienceSource;
  idempotencyKey?: string;
}): Promise<OneTimeBroadcastOutcome> {
  const { pubkey, subject, bodyHtml, audienceSource } = params;
  const contentKey = contentHash([subject, bodyHtml, audienceSource ?? "all"]);
  const claimKey = params.idempotencyKey
    ? `${BROADCAST_KEY_PREFIX}agent:${params.idempotencyKey}`
    : `${BROADCAST_KEY_PREFIX}content:${contentKey}`;

  // FAIL-CLOSED: verified custom sender domain required — never blast a
  // seller's audience from the platform's global sender.
  const fromEmail = await resolveSellerSenderEmail(pubkey);
  if (!fromEmail) return { kind: "no-sender" };

  const baseUrl = getSiteUrl();
  // FAIL-CLOSED: unsubscribe secret must be configured (probe mints one URL).
  try {
    buildSellerEmailUnsubscribeUrl(baseUrl, pubkey, "probe@example.com");
  } catch {
    return { kind: "unsubscribe-unavailable" };
  }

  // Content-keyed per-recipient ledger: what a retry (any claim key) must
  // skip. Read BEFORE claiming so an empty outcome never burns cap budget.
  const priorRecipients = await getOneTimeBroadcastRecipients(
    pubkey,
    contentKey
  );
  if (priorRecipients === null) return { kind: "claim-failed" };

  const rawAudience = Array.from(
    new Set(
      (await getSellerAudienceEmails(pubkey, audienceSource)).map((e) =>
        e.toLowerCase()
      )
    )
  ).filter((e) => EMAIL_RE.test(e));
  if (rawAudience.length === 0) return { kind: "empty-audience" };

  const alreadyEmailed = new Set(priorRecipients.map((e) => e.toLowerCase()));
  const audience = rawAudience
    .filter((e) => !alreadyEmailed.has(e))
    .slice(0, MAX_AUDIENCE);
  if (audience.length === 0) return { kind: "already-sent" };

  // Capped one-shot claim AFTER every skip condition. "exists" = a retry of
  // an in-progress or finished send: fall through and let the content-keyed
  // recipient ledger resume only the undelivered.
  const claim = await claimOneTimeBroadcastWithCap(
    pubkey,
    claimKey,
    contentKey,
    BROADCAST_DAILY_LIMIT,
    BROADCAST_KEY_PREFIX
  );
  if (claim === null) return { kind: "claim-failed" };
  if (claim === "limit") return { kind: "daily-limit" };
  // A reused idempotency key carrying DIFFERENT content would bypass the
  // daily cap (one key, unlimited distinct broadcasts) — reject it.
  if (claim === "mismatch") return { kind: "key-mismatch" };

  const branding = await loadStorefrontBranding(pubkey);
  const shopName = branding?.shopName || "our shop";

  let sent = 0;
  let failed = 0;
  const queue = [...audience];

  const worker = async () => {
    for (;;) {
      const to = queue.shift();
      if (!to) return;
      // Atomic per-recipient delivery claim: at most one delivery per contact
      // per content, even across concurrent retries with different keys.
      const ownsDelivery = await claimOneTimeBroadcastRecipient(
        pubkey,
        contentKey,
        to
      );
      if (ownsDelivery === null) {
        // DB error mid-blast: count as failed. Do NOT release this recipient
        // claim — its state is unknown (at-most-once failure mode, same as
        // the blog broadcast).
        failed++;
        continue;
      }
      if (!ownsDelivery) continue; // a concurrent send already claimed it
      // The audience snapshot was read BEFORE this claim. A concurrent send
      // may have durably suppressed this address in between (its claim was
      // released only AFTER suppression landed), and this worker can then
      // have reclaimed the released row with the stale snapshot still in
      // hand. Re-check suppression NOW — after claiming — so that racing
      // retry can never re-email a dead address. FAIL CLOSED: if the check
      // itself errors (null), treat it as a failed send and KEEP the claim,
      // the same at-most-once posture as any mid-blast DB error.
      const suppressedNow = await isSellerEmailUnsubscribedStrict(pubkey, to);
      if (suppressedNow === null) {
        failed++;
        continue;
      }
      if (suppressedNow) continue; // claimed after suppression landed: skip
      try {
        const unsubscribeUrl = buildSellerEmailUnsubscribeUrl(
          baseUrl,
          pubkey,
          to
        );
        const rendered = buildOneTimeEmail({
          subject,
          bodyHtml,
          shopName,
          unsubscribeUrl,
          style: branding?.style,
        });
        const result = await sendEmailStrictFromDetailed({
          to,
          subject: rendered.subject,
          html: rendered.html,
          fromEmail,
          fromName: branding?.shopName,
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });
        if (result.ok) {
          sent++;
          continue;
        }
        failed++;
        if (result.definiteReject) {
          if (result.recipientReject) {
            // The rejection blamed the RECIPIENT address itself (invalid or
            // on SendGrid's suppression list): it will fail every future
            // send identically, so durably suppress it. The address goes
            // onto the seller's per-seller suppression list, which
            // getSellerAudienceEmails already filters out of EVERY future
            // audience (any content key, any segment, blog or one-time) —
            // without this, every retry re-burns quota and sender reputation
            // on a provably dead address. Narrower than definiteReject on
            // purpose: account/sender-level 4xx (e.g. a lapsed domain auth
            // 403) fails the WHOLE audience and must never suppress anyone.
            //
            // Suppress BEFORE releasing the recipient claim, while this
            // worker still holds it: a concurrent retry cannot reclaim the
            // address in between, and if the suppression write fails the
            // claim STAYS (fail closed) so the dead address is never
            // retryable — the retained ledger row blocks re-delivery just
            // like an ambiguous failure does.
            const suppressed = await unsubscribeSellerEmail(
              pubkey,
              to,
              "suppressed"
            );
            if (!suppressed) {
              // Suppression persistence failed. The retained claim blocks
              // same-content retries; a NEW-content broadcast will re-attempt
              // the address once, hit the same recipient-level provider
              // reject, and retry the suppression write — self-healing, and
              // bounded by the daily cap. Never release the claim here.
              console.error(
                `One-time broadcast: failed to durably suppress dead address; ` +
                  `keeping its recipient claim so no retry can re-attempt it`
              );
              continue;
            }
          }
          // A 4xx means SendGrid refused the message — nothing was accepted,
          // so freeing the claim lets a later retry re-attempt safely. For a
          // recipient-level reject the suppression above has already landed,
          // so the released claim can never make the address retryable.
          await releaseOneTimeBroadcastRecipient(pubkey, contentKey, to);
        }
        // Ambiguous failure (timeout/5xx): the claim STAYS so a retry can
        // never duplicate a message SendGrid may have accepted.
      } catch (err) {
        console.error("One-time broadcast send error:", err);
        failed++;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SEND_CONCURRENCY, audience.length) }, worker)
  );

  // If NOTHING went out (e.g. SendGrid was down), report all-failed. On a
  // FRESH claim, also release the claim so the retry doesn't burn the daily
  // cap. Safe either way: the content-keyed recipient ledger still blocks any
  // duplicate delivery.
  if (sent === 0 && failed > 0) {
    if (claim === "claimed") {
      await releaseOneTimeBroadcast(pubkey, claimKey);
    }
    return { kind: "all-failed", sent, failed, total: audience.length };
  }

  return { kind: "sent", sent, failed, total: audience.length };
}

/**
 * Send one test email to a single address (subject prefixed [TEST]). Uses the
 * generic sender — parity with the email-flow send-test route. Attempts are
 * capped per day (per-content keys carry a UTC day bucket) so a looping agent
 * can't abuse the platform sender reputation.
 */
export async function sendOneTimeTestEmail(params: {
  pubkey: string;
  to: string;
  subject: string;
  bodyHtml: string;
}): Promise<{ ok: boolean; error?: string }> {
  const to = params.to.trim().toLowerCase();
  if (!EMAIL_RE.test(to)) return { ok: false, error: "Invalid target_email" };

  // Attempts are what need capping (not distinct content): the key carries a
  // UTC day bucket, so identical content can't be re-sent to an arbitrary
  // address more than once per day, and the cap bounds total daily sends.
  const dayBucket = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const contentKey = contentHash([to, params.subject, params.bodyHtml]);
  const claimKey = `${TEST_KEY_PREFIX}${dayBucket}:${contentKey}`;
  const claim = await claimOneTimeBroadcastWithCap(
    params.pubkey,
    claimKey,
    contentKey,
    TEST_DAILY_LIMIT,
    TEST_KEY_PREFIX
  );
  if (claim === null) {
    return {
      ok: false,
      error: "Could not verify the send allowance (database busy). Try again.",
    };
  }
  if (claim === "limit") {
    return {
      ok: false,
      error: `Daily test-email limit reached (${TEST_DAILY_LIMIT} per day).`,
    };
  }
  if (claim === "exists") {
    return {
      ok: false,
      error:
        "This exact test email was already sent today. Change the content or try again tomorrow.",
    };
  }

  try {
    const branding = await loadStorefrontBranding(params.pubkey);
    const shopName = branding?.shopName || "our shop";
    const rendered = renderFlowEmail(
      params.subject,
      params.bodyHtml,
      { shop_name: shopName },
      branding?.style
    );
    const ok = await sendEmail(to, `[TEST] ${rendered.subject}`, rendered.html);
    return ok
      ? { ok: true }
      : { ok: false, error: "The email provider rejected the send" };
  } catch (err) {
    console.error("One-time test email failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : "Unknown" };
  }
}
