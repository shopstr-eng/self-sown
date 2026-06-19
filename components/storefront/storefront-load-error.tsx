import { useEffect } from "react";
import MilkMarketSpinner from "@/components/utility-components/mm-spinner";

type StorefrontLoadErrorProps = {
  /** Called to re-attempt the lookup. */
  onRetry: () => void;
  /** What failed to load, e.g. "stall" or "shop". */
  label?: string;
};

/**
 * Shown when a stall/custom-domain page can't resolve its shop because of a
 * TRANSIENT failure (network drop, server hiccup) rather than a definitive
 * 404. Unlike the old "Not Found" dead-end this keeps the page recoverable: it
 * auto-retries on an interval and offers a manual retry button.
 */
export default function StorefrontLoadError({
  onRetry,
  label = "shop",
}: StorefrontLoadErrorProps) {
  // Auto-retry periodically so the page heals itself once the hiccup clears,
  // even if the visitor never touches the retry button.
  useEffect(() => {
    const interval = setInterval(onRetry, 5000);
    return () => clearInterval(interval);
  }, [onRetry]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 pt-20 text-center">
      <MilkMarketSpinner />
      <h1 className="mt-6 text-2xl font-bold">Having trouble loading</h1>
      <p className="mt-3 max-w-md text-gray-500">
        We couldn&apos;t load this {label} right now. This is usually a brief
        connection hiccup, we&apos;ll keep trying automatically.
      </p>
      <button
        onClick={onRetry}
        className="bg-primary-blue mt-6 rounded-lg px-6 py-3 font-bold text-white transition-transform hover:-translate-y-0.5"
      >
        Try again
      </button>
    </div>
  );
}
