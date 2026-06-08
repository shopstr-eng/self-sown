// Lifecycle automation for the Pro tier: expires trials, warns before each
// transition, and flips lapsed content read-only → hidden via reminder flags.
// Driven by the internal scheduler (see utils/email/flow-scheduler.ts) hitting
// /api/pro/cron-lifecycle. The actual status is always resolved from the stored
// timeline; this routine only sends the one-time notifications.

import {
  listAllProMemberships,
  markProReminderSent,
  type ProReminderColumn,
} from "@/utils/db/pro-membership";
import { resolveMembershipStatus } from "@/utils/pro/membership-status";
import { DAY_MS } from "@/utils/pro/constants";
import { getSellerNotificationEmail } from "@/utils/db/db-service";
import { sendEmail } from "@/utils/email/email-service";
import { sendServerSideNostrDM } from "@/utils/nostr/server-nostr-helpers";
import { deactivateApiKeysForPubkey } from "@/utils/mcp/auth";

const TRIAL_ENDING_WINDOW_MS = 7 * DAY_MS;

interface Notice {
  column: ProReminderColumn;
  subject: string;
  body: string;
}

async function notifySeller(pubkey: string, notice: Notice): Promise<void> {
  const html = `<p>${notice.body}</p>`;
  try {
    const email = await getSellerNotificationEmail(pubkey);
    if (email) {
      await sendEmail(email, notice.subject, html);
    }
  } catch (err) {
    console.warn("Pro lifecycle: email send failed", err);
  }
  try {
    await sendServerSideNostrDM(pubkey, notice.body, notice.subject);
  } catch (err) {
    console.warn("Pro lifecycle: Nostr DM failed", err);
  }
  await markProReminderSent(pubkey, notice.column);
}

export interface ProLifecycleResult {
  scanned: number;
  trialEndingNotices: number;
  dueNotices: number;
  readonlyNotices: number;
  hiddenNotices: number;
  apiKeysRevoked: number;
}

// Revoke a lapsed seller's MCP API keys so their agents can no longer manage
// the shop once they're off the paid tier. Best-effort and idempotent: failures
// are logged, not thrown, so a DB hiccup never blocks the lifecycle notices.
async function revokeMcpAccess(
  pubkey: string,
  result: ProLifecycleResult
): Promise<void> {
  try {
    result.apiKeysRevoked += await deactivateApiKeysForPubkey(pubkey);
  } catch (err) {
    console.warn("Pro lifecycle: MCP API key revoke failed", err);
  }
}

export async function runProLifecycle(
  nowMs: number = Date.now()
): Promise<ProLifecycleResult> {
  const rows = await listAllProMemberships();
  const result: ProLifecycleResult = {
    scanned: rows.length,
    trialEndingNotices: 0,
    dueNotices: 0,
    readonlyNotices: 0,
    hiddenNotices: 0,
    apiKeysRevoked: 0,
  };

  for (const row of rows) {
    const status = resolveMembershipStatus(row, nowMs);

    // 1) Trial ending soon — still trialing, trial_end within the window.
    if (status === "trialing" && !row.trial_reminder_sent_at) {
      const trialEnd = row.trial_end
        ? new Date(row.trial_end as any).getTime()
        : 0;
      if (trialEnd > 0 && trialEnd - nowMs <= TRIAL_ENDING_WINDOW_MS) {
        await notifySeller(row.pubkey, {
          column: "trial_reminder_sent_at",
          subject: "Your Milk Market Herd trial is ending soon",
          body: "Your free Milk Market Herd trial ends soon. Subscribe to keep your Herd features (custom storefront, custom domains, email flows, custom product pages, shipping (coming soon), and the MCP API) active.",
        });
        result.trialEndingNotices += 1;
      }
      continue;
    }

    // 2) Payment overdue — entitlement ended, inside the grace window.
    if (status === "grace" && !row.due_reminder_sent_at) {
      await notifySeller(row.pubkey, {
        column: "due_reminder_sent_at",
        subject: "Action needed: your Milk Market Herd payment is overdue",
        body: "Your Milk Market Herd plan has lapsed. Pay now to avoid your Herd features becoming read-only. If you don't pay, they'll go read-only soon and be hidden a month later.",
      });
      result.dueNotices += 1;
      continue;
    }

    // 3) Content just went read-only — the first non-entitled state. Revoke the
    // seller's MCP API keys here so agents can't keep managing the shop.
    if (status === "readonly" && !row.readonly_notice_sent_at) {
      await revokeMcpAccess(row.pubkey, result);
      await notifySeller(row.pubkey, {
        column: "readonly_notice_sent_at",
        subject: "Your Milk Market Herd features are now read-only",
        body: "Your Milk Market Herd plan is still unpaid, so your Herd features are now read-only. They'll stay visible for one month, then be hidden from the public. Re-subscribe to unlock editing again.",
      });
      result.readonlyNotices += 1;
      continue;
    }

    // 4) Content now hidden. Revoke again in case the cron never observed the
    // read-only window (e.g. it skipped straight to hidden); idempotent no-op
    // when keys were already deactivated above.
    if (status === "hidden" && !row.hidden_notice_sent_at) {
      await revokeMcpAccess(row.pubkey, result);
      await notifySeller(row.pubkey, {
        column: "hidden_notice_sent_at",
        subject: "Your Milk Market Herd features are now hidden",
        body: "Your Milk Market Herd plan stayed unpaid, so your Herd features are now hidden from the public. Re-subscribe anytime to restore them.",
      });
      result.hiddenNotices += 1;
      continue;
    }
  }

  return result;
}
