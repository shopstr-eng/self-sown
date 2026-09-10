import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/router";

const POLL_INTERVAL_MS = 60_000;

/**
 * Global "new version is live" prompt. A tab's code comes from the build that
 * served its HTML (__NEXT_DATA__.buildId); the server reports the build it is
 * currently serving (/api/version). When they diverge a rebuild/publish has
 * swapped in new chunks under this tab — prompt a refresh rather than letting
 * the tab rot on stale code. Pairs with the dev-server chunk carry-forward,
 * which keeps the old tab's chunks fetchable until the user does refresh.
 */
export default function UpdateToast() {
  const router = useRouter();
  const [serverBuildId, setServerBuildId] = useState<string | null>(null);
  const [dismissedBuildId, setDismissedBuildId] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return;
      const { buildId } = (await res.json()) as { buildId?: string };
      if (buildId && buildId !== "dev") {
        setServerBuildId(buildId);
      } else if (buildId === "dev") {
        // Origin switched to a dev server mid-session — retract any prompt.
        setServerBuildId(null);
      }
    } catch {
      // Offline or mid-restart — retry on the next poll/focus.
    }
  }, []);

  useEffect(() => {
    check();
    const interval = setInterval(check, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  const tabBuildId =
    typeof window === "undefined"
      ? undefined
      : (window as { __NEXT_DATA__?: { buildId?: string } }).__NEXT_DATA__
          ?.buildId;

  if (
    !serverBuildId ||
    !tabBuildId ||
    serverBuildId === tabBuildId ||
    serverBuildId === dismissedBuildId
  ) {
    return null;
  }

  return (
    <div
      role="status"
      className="fixed right-4 bottom-4 z-[9999] flex max-w-sm items-center gap-3 border-2 border-black bg-yellow-300 p-4 text-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]"
    >
      <span className="text-sm font-bold">
        A new version of Milk Market is live.
      </span>
      <button
        type="button"
        onClick={() => router.reload()}
        className="shrink-0 border-2 border-black bg-black px-3 py-1 text-sm font-bold text-yellow-300 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] transition-all hover:-translate-y-0.5 hover:shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]"
      >
        Refresh
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissedBuildId(serverBuildId)}
        className="shrink-0 text-lg leading-none font-bold"
      >
        ×
      </button>
    </div>
  );
}
