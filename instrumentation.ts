export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Background jobs must never take down server boot: a failure here is
    // logged and otherwise ignored so the process keeps serving requests.
    try {
      const { startFlowScheduler } = await import(
        "./utils/email/flow-scheduler"
      );
      startFlowScheduler();
    } catch (error) {
      console.error("[instrumentation] Failed to start background jobs:", error);
    }
  }
}
