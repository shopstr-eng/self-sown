/**
 * Shared wrapper for Replit-injected Umami project analytics. The tracker is
 * only present in the published app (and only after analytics is enabled in
 * Publishing settings), so every call is optional-chained and swallowed —
 * analytics must never break the app.
 */
type AnalyticsData = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void;
    };
  }
}

export function trackEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === "undefined") return;

  try {
    window.umami?.track(name, data);
  } catch {
    // Analytics must never break the app.
  }
}
