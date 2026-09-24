import { getSendGridApiKey } from "./sendgrid-client";
import {
  recordSendGridSuppressedEmails,
  suppressDeadAudienceEmails,
} from "@/utils/db/db-service";
import { getProSetting, setProSetting } from "@/utils/db/pro-membership";

const SENDGRID_API_BASE = "https://api.sendgrid.com";
const DEFAULT_PAGE_LIMIT = 500;
// Safety bound per list per run so one runaway sync can't hang the cron. When
// the cap is hit, the list's position is persisted and the NEXT run resumes
// where this one stopped (see SyncState below) instead of restarting.
const DEFAULT_MAX_PAGES_PER_LIST = 20;

/**
 * The SendGrid suppression lists that prove an address is permanently dead:
 *   - /v3/suppression/bounces      — hard bounces SendGrid now suppresses
 *   - /v3/suppression/spam_reports — recipients who reported our mail as spam
 * (/v3/suppression/blocks is deliberately EXCLUDED: blocks are transient
 * soft-bounce throttling, and recording one as a permanent suppression would
 * wrongly silence a reachable contact.)
 */
const SUPPRESSION_LISTS = ["bounces", "spam_reports"] as const;
type SuppressionList = (typeof SUPPRESSION_LISTS)[number];

/**
 * Per-list resumable sync position, persisted as JSON in pro_settings.
 *   - wm:      high-water mark — everything with created >= wm is recorded.
 *   - cursor:  while draining a backlog larger than one run's page cap, the
 *              OLDEST created timestamp processed so far; the next run
 *              resumes by fetching entries with end_time=cursor (SendGrid
 *              returns entries newest-first, so a start_time-only watermark
 *              would re-fetch the same newest pages forever). Null when no
 *              backlog is in flight.
 *   - pending: the newest created seen during the current backlog drain;
 *              becomes the new wm once the backlog is exhausted.
 */
interface SyncState {
  wm: number;
  cursor: number | null;
  pending: number | null;
}

const STATE_KEY_PREFIX = "sendgrid_suppression_sync_v2:";

interface SuppressionEntry {
  email?: string;
  created?: number;
}

export interface SuppressionSyncResult {
  ok: boolean;
  /** Suppressed addresses pulled from SendGrid this run (all lists). */
  fetched: number;
  /** (seller, email) suppression rows newly written. */
  recorded: number;
  error?: string;
}

async function loadState(list: SuppressionList): Promise<SyncState> {
  const raw = await getProSetting(`${STATE_KEY_PREFIX}${list}`);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.wm === "number") {
        return {
          wm: parsed.wm,
          cursor: typeof parsed.cursor === "number" ? parsed.cursor : null,
          pending: typeof parsed.pending === "number" ? parsed.pending : null,
        };
      }
    } catch {
      // Corrupt state: fall through to a fresh full backfill (idempotent).
    }
  }
  return { wm: 0, cursor: null, pending: null };
}

async function saveState(list: SuppressionList, state: SyncState) {
  await setProSetting(`${STATE_KEY_PREFIX}${list}`, JSON.stringify(state));
}

async function fetchSuppressionPage(
  apiKey: string,
  list: SuppressionList,
  opts: { startTime: number; endTime: number | null; limit: number; offset: number }
): Promise<SuppressionEntry[]> {
  const params = new URLSearchParams({
    limit: String(opts.limit),
    offset: String(opts.offset),
  });
  if (opts.startTime > 0) params.set("start_time", String(opts.startTime));
  if (opts.endTime !== null) params.set("end_time", String(opts.endTime));
  const res = await fetch(
    `${SENDGRID_API_BASE}/v3/suppression/${list}?${params}`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  if (!res.ok) {
    throw new Error(`SendGrid ${list} list request failed (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data) ? (data as SuppressionEntry[]) : [];
}

/**
 * Pull SendGrid's bounce/spam-report suppression lists and record every
 * address two ways:
 *   1. account-global cache (sendgrid_suppressed_emails) — audience queries
 *      filter against it, so a dead address is excluded even for sellers who
 *      capture it AFTER this sync ran;
 *   2. per-seller 'suppressed' unsubscribe rows (email_unsubscribes) for
 *      every seller whose audience currently contains it, so sellers can see
 *      which of THEIR contacts died.
 *
 * Why this exists: send-time suppression in the broadcast only sees addresses
 * SendGrid REJECTS synchronously (4xx). Most dead addresses are ACCEPTED and
 * bounce asynchronously minutes later; without this sync the unsubscribe
 * list never learns about them and every future broadcast re-burns sender
 * reputation on provably dead addresses.
 *
 * Resumable: each list's position is persisted per run and only advances
 * after its fetched pages are fully recorded; a failure mid-list leaves that
 * list's state untouched so the next run retries the same window. Recording
 * is idempotent at both layers (ON CONFLICT keeps the original unsubscribe
 * reason), so overlap can never double-write or rewrite a 'user' opt-out.
 * Lists are processed independently: one capped or failing list never
 * starves the other.
 */
export async function syncSendGridSuppressions(opts?: {
  pageLimit?: number;
  maxPagesPerList?: number;
}): Promise<SuppressionSyncResult> {
  const pageLimit = opts?.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = opts?.maxPagesPerList ?? DEFAULT_MAX_PAGES_PER_LIST;

  let apiKey: string;
  try {
    apiKey = await getSendGridApiKey();
  } catch (error) {
    const message = error instanceof Error ? error.message : "no api key";
    return { ok: false, fetched: 0, recorded: 0, error: message };
  }

  let fetched = 0;
  let recorded = 0;
  const errors: string[] = [];

  for (const list of SUPPRESSION_LISTS) {
    try {
      const state = await loadState(list);
      // During a backlog drain we re-walk the window [wm .. cursor]; pending
      // carries the newest timestamp seen by the run that opened the backlog.
      let maxSeen = state.pending ?? state.wm;
      let oldestSeen = Number.POSITIVE_INFINITY;
      let drained = false;

      for (let page = 0; page < maxPages; page++) {
        const entries = await fetchSuppressionPage(apiKey, list, {
          startTime: state.wm,
          endTime: state.cursor,
          limit: pageLimit,
          offset: page * pageLimit,
        });
        if (entries.length === 0) {
          drained = true;
          break;
        }

        const emails = entries
          .map((e) => e?.email)
          .filter((e): e is string => typeof e === "string");
        const [cached, written] = await Promise.all([
          recordSendGridSuppressedEmails(
            emails.map((email) => ({ email, list }))
          ),
          suppressDeadAudienceEmails(emails),
        ]);
        if (cached === null || written === null) {
          // DB error: recording state is unknown, so do NOT advance this
          // list's position — a retry must re-pull this window.
          throw new Error(`failed to record ${list} suppressions`);
        }
        fetched += emails.length;
        recorded += written;

        for (const e of entries) {
          if (typeof e?.created === "number") {
            if (e.created > maxSeen) maxSeen = e.created;
            if (e.created < oldestSeen) oldestSeen = e.created;
          }
        }

        if (entries.length < pageLimit) {
          drained = true; // window exhausted
          break;
        }
      }

      if (drained) {
        // The window [wm .. cursor|now] is fully recorded. Entries newer than
        // pending that arrive during a backlog drain are caught by the next
        // run because start_time=wm is inclusive. Overlap at the second
        // boundary is intentional (idempotent) so a same-second entry is
        // never skipped.
        await saveState(list, { wm: maxSeen, cursor: null, pending: null });
      } else {
        // Page cap hit mid-window: persist a resume point at the OLDEST entry
        // processed (end_time walks backward next run) and keep the newest
        // seen as the future watermark. wm stays — the window is not yet
        // fully synced.
        if (!Number.isFinite(oldestSeen)) {
          throw new Error(`capped ${list} sync saw no timestamps`);
        }
        await saveState(list, {
          wm: state.wm,
          cursor: oldestSeen,
          pending: maxSeen,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "sync failed";
      errors.push(`${list}: ${message}`);
    }
  }

  return {
    ok: errors.length === 0,
    fetched,
    recorded,
    error: errors.length ? errors.join("; ") : undefined,
  };
}
