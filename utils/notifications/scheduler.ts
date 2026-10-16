let schedulerStarted = false;

function getBaseUrl(): string {
  const port = process.env.PORT || 5000;
  return `http://localhost:${port}`;
}

async function dispatchPendingPushes() {
  const secret = process.env.MOBILE_PUSH_PROCESSOR_SECRET;
  if (!secret) return;

  try {
    const res = await fetch(`${getBaseUrl()}/api/mobile/notifications/process`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
    });
    const data = await res.json();
    const r = data?.result;
    if (
      r &&
      (r.queued > 0 || r.claimed > 0 || r.accepted > 0 || r.checkedReceipts > 0)
    ) {
      console.log("[push-scheduler] /api/mobile/notifications/process:", r);
    }
  } catch (error: any) {
    // Boot races: the tick can fire before the server accepts connections.
    if (
      error?.cause?.code !== "ECONNREFUSED" &&
      error?.code !== "ECONNREFUSED"
    ) {
      console.error(
        "[push-scheduler] /api/mobile/notifications/process error:",
        error?.message
      );
    }
  }
}

/**
 * In-process dispatcher for seller activity pushes: POSTs the process endpoint
 * roughly once a minute so queued order/message notifications reach devices.
 * The endpoint self-limits (internal time budget, DB leases), so the overlap
 * guard here is just defense against a hung tick stacking concurrent runs.
 * Rollback: set MOBILE_SELLER_PUSH_ENABLED=false and restart — the scheduler
 * stays off, and the endpoint would no-op anyway.
 */
export function startMobilePushScheduler() {
  if (schedulerStarted) return;
  // Checked here only to keep logs clean; the endpoint independently
  // re-verifies the flag on every call and no-ops when disabled. (Checking
  // env directly keeps the DB-heavy runtime module out of the import graph.)
  if (process.env.MOBILE_SELLER_PUSH_ENABLED !== "true") {
    console.log(
      "[push-scheduler] MOBILE_SELLER_PUSH_ENABLED not set, scheduler disabled"
    );
    return;
  }
  if (!process.env.MOBILE_PUSH_PROCESSOR_SECRET) {
    console.log(
      "[push-scheduler] MOBILE_PUSH_PROCESSOR_SECRET not set, scheduler disabled"
    );
    return;
  }
  if (process.env.NODE_ENV === "development") {
    console.log(
      "[push-scheduler] Skipping scheduler in development mode to reduce memory pressure"
    );
    return;
  }

  schedulerStarted = true;
  console.log("[push-scheduler] Starting mobile push dispatcher");

  const PROCESS_INTERVAL = 60 * 1000;

  let running = false;
  const guardedTick = async () => {
    if (running) {
      console.warn(
        "[push-scheduler] process: previous run still in flight, skipping this tick"
      );
      return;
    }
    running = true;
    try {
      await dispatchPendingPushes();
    } finally {
      running = false;
    }
  };

  setTimeout(() => void guardedTick(), 75 * 1000);
  setInterval(() => void guardedTick(), PROCESS_INTERVAL);
}
