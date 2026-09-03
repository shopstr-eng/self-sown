import {
  getProSetting,
  setProSetting,
  withProSettingsLock,
} from "@/utils/db/pro-membership";

// Once an ops alert has gone out for a given subject (e.g. a Stripe
// subscription), suppress repeats for this long. The structured console logs
// still record every event; only the email is rate-limited.
export const OPS_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type DedupedOpsAlertOutcome = "sent" | "suppressed" | "failed";

/**
 * Send an ops alert email at most once per `cooldownMs` per `dedupKey`,
 * deduped via `pro_settings` and serialized per key with a Postgres advisory
 * lock so concurrent webhook events for the same subject can't double-send
 * (both reading a missing/expired timestamp before either stamps). The dedup
 * timestamp is written ONLY after a mail actually goes out, so a transient
 * mail failure re-alerts on the next event. Best-effort: never throws, so it
 * can't fail the caller's webhook response.
 */
export async function sendDedupedOpsAlert(options: {
  dedupKey: string;
  send: () => Promise<boolean>;
  /** Log prefix used when the helper itself fails, e.g. "[my_alert]". */
  logTag: string;
  cooldownMs?: number;
}): Promise<DedupedOpsAlertOutcome> {
  const cooldownMs = options.cooldownMs ?? OPS_ALERT_COOLDOWN_MS;
  try {
    return await withProSettingsLock(options.dedupKey, async () => {
      const last = await getProSetting(options.dedupKey);
      if (last) {
        const lastMs = new Date(last).getTime();
        if (
          Number.isFinite(lastMs) &&
          Date.now() - lastMs < cooldownMs
        ) {
          return "suppressed";
        }
      }

      const sent = await options.send();
      if (!sent) return "failed";

      await setProSetting(options.dedupKey, new Date().toISOString());
      return "sent";
    });
  } catch (err) {
    console.error(`${options.logTag} Failed to send ops alert email:`, err);
    return "failed";
  }
}
