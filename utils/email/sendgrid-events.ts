import crypto from "crypto";
import { unsubscribeSellerEmail } from "@/utils/db/db-service";

/**
 * SendGrid Event Webhook processing: SendGrid accepts a message and only
 * LATER learns the address is dead (mailbox gone, domain dead, spam-block
 * bounce). Those outcomes never reach the synchronous send path, so without
 * this receiver every future broadcast keeps re-emailing provably dead
 * addresses — burning quota and sender reputation. This module verifies the
 * signed webhook and records bounce/dropped/spamreport events as per-seller
 * 'suppressed' unsubscribes, keyed to the owning seller via the
 * `seller_pubkey` custom arg the broadcast senders stamp on every message.
 *
 * The periodic suppression-list sync (utils/email/sendgrid-suppressions.ts)
 * remains the backstop: it covers events whose webhook delivery failed and
 * sends that never carried a seller arg (order/flow mail).
 */

/** Custom arg the broadcast senders stamp; SendGrid echoes it on each event. */
export const SELLER_PUBKEY_CUSTOM_ARG = "seller_pubkey";

/** Event types that CAN prove an address is dead (subject to the per-type
 * permanence checks below — a transient outcome must never suppress). */
const SUPPRESSING_EVENTS = new Set(["bounce", "dropped", "spamreport"]);

/**
 * Drop reasons that are provably PERMANENT: the address is on one of
 * SendGrid's permanent suppression lists (or undeliverable outright), so it
 * fails every future send identically. Any other/no reason — throttling,
 * content-triggered drops, account-level drops — is transient or
 * message-specific and must never permanently remove a reachable contact.
 * Mirrors the suppression sync's policy of excluding the (transient) blocks
 * list: these per-seller unsubscribe rows do not expire.
 */
const PERMANENT_DROP_REASON =
  /bounced address|spam reporting address|unsubscribed address|invalid/i;

/**
 * Whether an event proves the address must never be re-emailed. Conservative
 * by construction: a false positive permanently shrinks a seller's audience,
 * while a false negative is re-covered by the daily suppression-list sync.
 */
function isPermanentFailure(event: any): boolean {
  switch (event?.event) {
    case "spamreport":
      // A deliberate recipient action — always permanent.
      return true;
    case "bounce":
      // SendGrid marks soft bounces (temporary blocks/throttling) as
      // type=blocked; they resolve on their own and must never suppress.
      return typeof event?.type === "string"
        ? event.type.toLowerCase() !== "blocked"
        : true; // no type field: hard bounce is the documented default
    case "dropped":
      return PERMANENT_DROP_REASON.test(
        typeof event?.reason === "string" ? event.reason : ""
      );
    default:
      return false;
  }
}

// Ed25519 SPKI DER prefix: SendGrid's "verification key" is the base64 of the
// raw 32-byte public key; Node needs it wrapped in the standard SPKI header.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Verify SendGrid's signed Event Webhook request. The signature is Ed25519
 * over `timestamp + rawBody` (the raw, unparsed request body), delivered in
 * the X-Twilio-Email-Event-Webhook-{Signature,Timestamp} headers. Returns
 * false on any malformation — never throws — so callers fail closed.
 */
export function verifySendGridEventSignature(
  publicKeyBase64: string,
  signatureBase64: string,
  timestamp: string,
  rawBody: Buffer
): boolean {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([
        ED25519_SPKI_PREFIX,
        Buffer.from(publicKeyBase64, "base64"),
      ]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      null,
      Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]),
      key,
      Buffer.from(signatureBase64, "base64")
    );
  } catch {
    return false;
  }
}

export interface SendGridEventProcessResult {
  /** Events that reported a dead address AND carried a seller arg. */
  suppressible: number;
  /** Suppression rows durably written. */
  suppressed: number;
  /** Suppression writes that failed (logged; the cron sync is the backstop). */
  failed: number;
  /** Events ignored: not a suppressing type, or no seller/email attribution. */
  skipped: number;
}

/**
 * Record per-seller 'suppressed' unsubscribes for every dead-address event.
 * Best-effort per event: one failure never blocks the rest of the batch, and
 * the caller still answers 200 (SendGrid retries a non-2xx by re-posting the
 * WHOLE batch, which would re-process events already recorded; the cron
 * suppression sync re-covers anything missed here).
 */
export async function processSendGridEvents(
  events: unknown
): Promise<SendGridEventProcessResult> {
  const result: SendGridEventProcessResult = {
    suppressible: 0,
    suppressed: 0,
    failed: 0,
    skipped: 0,
  };
  if (!Array.isArray(events)) return result;

  for (const event of events) {
    const type = typeof (event as any)?.event === "string" ? (event as any).event : "";
    if (!SUPPRESSING_EVENTS.has(type) || !isPermanentFailure(event)) {
      result.skipped++;
      continue;
    }
    const email =
      typeof (event as any)?.email === "string" ? (event as any).email : "";
    // Custom args surface as top-level keys on the event object; tolerate a
    // nested custom_args object too so a SendGrid payload-shape change can't
    // silently re-open the re-email gap.
    const sellerPubkey =
      typeof (event as any)?.[SELLER_PUBKEY_CUSTOM_ARG] === "string"
        ? (event as any)[SELLER_PUBKEY_CUSTOM_ARG]
        : typeof (event as any)?.custom_args?.[SELLER_PUBKEY_CUSTOM_ARG] ===
            "string"
          ? (event as any).custom_args[SELLER_PUBKEY_CUSTOM_ARG]
          : "";
    if (!email || !sellerPubkey) {
      // No seller attribution (e.g. order/flow mail, which carries no arg):
      // nothing to key the suppression to — the cron sync covers it globally.
      result.skipped++;
      continue;
    }

    result.suppressible++;
    try {
      const ok = await unsubscribeSellerEmail(sellerPubkey, email, "suppressed");
      if (ok) {
        result.suppressed++;
      } else {
        result.failed++;
        console.error(
          `SendGrid events: failed to record ${type} suppression for an address; ` +
            `the suppression-list sync will re-cover it`
        );
      }
    } catch (error) {
      result.failed++;
      console.error("SendGrid events: suppression write threw:", error);
    }
  }
  return result;
}
