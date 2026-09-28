let schedulerStarted = false;

function getBaseUrl(): string {
  const port = process.env.PORT || 5000;
  return `http://localhost:${port}`;
}

async function callEndpoint(path: string, body: Record<string, any> = {}) {
  const secret = process.env.FLOW_PROCESSOR_SECRET;
  if (!secret) return;

  try {
    const res = await fetch(`${getBaseUrl()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-flow-processor-secret": secret,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.processed > 0 || data.enrolled > 0) {
      console.log(`[flow-scheduler] ${path}:`, data);
    }
  } catch (error: any) {
    if (
      error?.cause?.code !== "ECONNREFUSED" &&
      error?.code !== "ECONNREFUSED"
    ) {
      console.error(`[flow-scheduler] ${path} error:`, error?.message);
    }
  }
}

async function processEmails() {
  await callEndpoint("/api/email/flows/process", { batch_size: 50 });
}

async function processAbandonedCarts() {
  await callEndpoint("/api/email/flows/cron-abandoned-cart", {
    stale_minutes: 60,
  });
}

async function processWinback() {
  await callEndpoint("/api/email/flows/cron-winback", { inactive_days: 30 });
}

async function processProLifecycle() {
  await callEndpoint("/api/pro/cron-lifecycle", {});
}

async function processScheduledBlogPosts() {
  await callEndpoint("/api/storefront/blog/process-scheduled", {
    batch_size: 20,
  });
}

async function processEscrowPayouts() {
  await callEndpoint("/api/cashu/escrow/process", { batch_size: 10 });
}

async function syncEmailSuppressions() {
  await callEndpoint("/api/email/cron-sync-suppressions", {});
}

/**
 * Wraps a scheduled task so a slow run (stuck DB, slow SendGrid call) can't
 * stack up concurrent copies of itself: while one run is in flight, later
 * ticks skip (and log) instead of starting a second one. The flag releases in
 * a finally, so even a throwing/hung-then-resolved run can't starve future
 * ticks forever.
 */
function withOverlapGuard(label: string, task: () => Promise<void>) {
  let running = false;
  return async function guardedTask() {
    if (running) {
      console.warn(
        `[flow-scheduler] ${label}: previous run still in flight, skipping this tick`
      );
      return;
    }
    running = true;
    try {
      await task();
    } finally {
      running = false;
    }
  };
}

export function startFlowScheduler() {
  if (schedulerStarted) return;
  if (!process.env.FLOW_PROCESSOR_SECRET) {
    console.log(
      "[flow-scheduler] FLOW_PROCESSOR_SECRET not set, scheduler disabled"
    );
    return;
  }

  if (process.env.NODE_ENV === "development") {
    console.log(
      "[flow-scheduler] Skipping scheduler in development mode to reduce memory pressure"
    );
    return;
  }

  schedulerStarted = true;
  console.log("[flow-scheduler] Starting email flow scheduler");

  const PROCESS_INTERVAL = 2 * 60 * 1000;
  const ABANDONED_CART_INTERVAL = 30 * 60 * 1000;
  const WINBACK_INTERVAL = 24 * 60 * 60 * 1000;
  const PRO_LIFECYCLE_INTERVAL = 6 * 60 * 60 * 1000;
  const SCHEDULED_BLOG_INTERVAL = 2 * 60 * 1000;
  const ESCROW_PAYOUT_INTERVAL = 60 * 1000;
  // Bounces land on SendGrid's suppression lists minutes after a send; an
  // hourly pull keeps dead addresses out of future broadcasts promptly.
  const SUPPRESSION_SYNC_INTERVAL = 60 * 60 * 1000;

  // Every task below is fire-and-forget: they all delegate to callEndpoint,
  // which try/catches and logs its own failures, so the timers intentionally
  // discard the promise (`void`) and let the next tick retry. Each is wrapped
  // in an overlap guard so a run that outlasts its interval doesn't stack a
  // second concurrent copy on top of itself; the initial setTimeout and the
  // setInterval share one guard since they run the same task.
  const guardedProcessEmails = withOverlapGuard("processEmails", processEmails);
  setTimeout(() => void guardedProcessEmails(), 30 * 1000);
  setInterval(() => void guardedProcessEmails(), PROCESS_INTERVAL);

  const guardedProcessAbandonedCarts = withOverlapGuard(
    "processAbandonedCarts",
    processAbandonedCarts
  );
  setTimeout(() => void guardedProcessAbandonedCarts(), 60 * 1000);
  setInterval(
    () => void guardedProcessAbandonedCarts(),
    ABANDONED_CART_INTERVAL
  );

  const guardedProcessWinback = withOverlapGuard(
    "processWinback",
    processWinback
  );
  setTimeout(() => void guardedProcessWinback(), 2 * 60 * 1000);
  setInterval(() => void guardedProcessWinback(), WINBACK_INTERVAL);

  const guardedProcessProLifecycle = withOverlapGuard(
    "processProLifecycle",
    processProLifecycle
  );
  setTimeout(() => void guardedProcessProLifecycle(), 3 * 60 * 1000);
  setInterval(() => void guardedProcessProLifecycle(), PRO_LIFECYCLE_INTERVAL);

  const guardedProcessScheduledBlogPosts = withOverlapGuard(
    "processScheduledBlogPosts",
    processScheduledBlogPosts
  );
  setTimeout(() => void guardedProcessScheduledBlogPosts(), 90 * 1000);
  setInterval(
    () => void guardedProcessScheduledBlogPosts(),
    SCHEDULED_BLOG_INTERVAL
  );

  // Escrow payouts are time-sensitive (buyers wait on releases/refunds), so
  // sweep promptly. The endpoint is a no-op unless escrow is enabled.
  const guardedProcessEscrowPayouts = withOverlapGuard(
    "processEscrowPayouts",
    processEscrowPayouts
  );
  setTimeout(() => void guardedProcessEscrowPayouts(), 45 * 1000);
  setInterval(() => void guardedProcessEscrowPayouts(), ESCROW_PAYOUT_INTERVAL);

  // Suppression sync is best-effort: SendGrid/DB failures are logged by the
  // endpoint and retried on the next tick (watermark only advances on a fully
  // recorded run).
  const guardedSyncEmailSuppressions = withOverlapGuard(
    "syncEmailSuppressions",
    syncEmailSuppressions
  );
  setTimeout(() => void guardedSyncEmailSuppressions(), 5 * 60 * 1000);
  setInterval(
    () => void guardedSyncEmailSuppressions(),
    SUPPRESSION_SYNC_INTERVAL
  );
}
