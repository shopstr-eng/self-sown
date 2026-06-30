import { useEffect, useRef, useState } from "react";
import { getSquareWebSdkUrl } from "@/utils/square/square-config";
import {
  EXCHANGE_RATE_BUYER_MESSAGE,
  EXCHANGE_RATE_ERROR_CODE,
} from "@/utils/stripe/currency";

// Minimal shape of the Square Web Payments SDK surface we use. The full SDK is
// loaded at runtime from Square's CDN (no npm dependency), so we declare just the
// pieces we call rather than pulling in the whole type package.
interface SquareTokenizeResult {
  status: string;
  token?: string;
  errors?: { message?: string }[];
}
interface SquareCard {
  attach: (selector: string | HTMLElement) => Promise<void>;
  tokenize: () => Promise<SquareTokenizeResult>;
  destroy?: () => Promise<void>;
}
interface SquarePayments {
  card: () => Promise<SquareCard>;
}
interface SquareSdk {
  payments: (applicationId: string, locationId: string) => SquarePayments;
}
declare global {
  interface Window {
    Square?: SquareSdk;
  }
}

// Load the Square Web Payments SDK script once (keyed by URL) and resolve when
// window.Square is available. Concurrent callers share the same in-flight load.
const sdkLoaders: Record<string, Promise<void>> = {};
function loadSquareSdk(url: string): Promise<void> {
  if (typeof window === "undefined")
    return Promise.reject(new Error("no window"));
  if (window.Square) return Promise.resolve();
  if (sdkLoaders[url]) return sdkLoaders[url];

  sdkLoaders[url] = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${url}"]`
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("Failed to load Square payment library"))
      );
      if (window.Square) resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error("Failed to load Square payment library"));
    document.head.appendChild(script);
  });
  return sdkLoaders[url];
}

export default function SquareCardForm({
  applicationId,
  locationId,
  environment,
  sellerPubkey,
  amount,
  currency,
  customerEmail,
  productTitle,
  metadata,
  onPaymentSuccess,
  onPaymentError,
  onCancel,
}: {
  applicationId: string;
  locationId: string;
  environment: "sandbox" | "production";
  sellerPubkey: string;
  // Buyer-facing amount in `currency`; the server converts + validates it.
  amount: number;
  currency: string;
  customerEmail?: string;
  productTitle?: string;
  metadata?: Record<string, unknown>;
  onPaymentSuccess: (paymentId: string) => void;
  onPaymentError: (error: string) => void;
  onCancel: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<SquareCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      try {
        await loadSquareSdk(getSquareWebSdkUrl(environment));
        if (cancelled) return;
        if (!window.Square) {
          throw new Error("Square payment library unavailable");
        }
        const payments = window.Square.payments(applicationId, locationId);
        const card = await payments.card();
        if (cancelled) {
          await card.destroy?.();
          return;
        }
        if (containerRef.current) {
          await card.attach(containerRef.current);
        }
        cardRef.current = card;
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setLoading(false);
        setErrorMessage(
          e instanceof Error ? e.message : "Failed to load payment form"
        );
      }
    };
    init();
    return () => {
      cancelled = true;
      const card = cardRef.current;
      cardRef.current = null;
      card?.destroy?.().catch(() => {});
    };
  }, [applicationId, locationId, environment]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const card = cardRef.current;
    if (!card || isProcessing) return;

    setIsProcessing(true);
    setErrorMessage(null);
    try {
      const result = await card.tokenize();
      if (result.status !== "OK" || !result.token) {
        const msg =
          result.errors?.[0]?.message ||
          "Card details were rejected. Please check and try again.";
        setErrorMessage(msg);
        setIsProcessing(false);
        return;
      }

      const res = await fetch("/api/square/create-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId: result.token,
          amount,
          currency,
          sellerPubkey,
          customerEmail,
          productTitle,
          metadata,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        // A 503 with EXCHANGE_RATE_UNAVAILABLE means the sats->USD conversion
        // feed was down; show the same friendly, retry-oriented message buyers
        // see on the Stripe path instead of a generic "payment failed".
        const msg =
          data?.code === EXCHANGE_RATE_ERROR_CODE
            ? EXCHANGE_RATE_BUYER_MESSAGE
            : data?.error || "Payment failed. Please try again.";
        setErrorMessage(msg);
        onPaymentError(msg);
        setIsProcessing(false);
        return;
      }
      onPaymentSuccess(data.paymentId as string);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Payment failed. Please try again.";
      setErrorMessage(msg);
      onPaymentError(msg);
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="shadow-neo rounded-md border-2 border-black bg-white p-4">
        {loading && (
          <div className="flex flex-col items-center justify-center py-6">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-black"></div>
            <p className="mt-3 text-sm font-bold text-black">
              Loading payment form...
            </p>
          </div>
        )}
        <div ref={containerRef} className={loading ? "hidden" : "block"} />
      </div>

      {errorMessage && (
        <div className="shadow-neo mt-3 rounded-md border-2 border-red-500 bg-red-50 px-4 py-3 text-sm font-bold text-red-600">
          {errorMessage}
        </div>
      )}

      <button
        type="submit"
        disabled={loading || isProcessing}
        className="shadow-neo mt-4 flex w-full transform items-center justify-center gap-2 rounded-md border-2 border-black bg-black px-4 py-3 font-bold text-white transition-transform hover:-translate-y-0.5 active:translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
      >
        {isProcessing ? (
          <>
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
            Processing payment...
          </>
        ) : (
          <>
            <span aria-hidden="true" className="text-lg leading-none">
              💳
            </span>
            Pay now
          </>
        )}
      </button>

      <button
        type="button"
        onClick={onCancel}
        className="mt-3 w-full text-center text-sm font-bold text-black underline hover:text-gray-700"
      >
        Cancel and return to checkout
      </button>
    </form>
  );
}
