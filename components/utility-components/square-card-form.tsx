import { useEffect, useRef, useState } from "react";
import { getSquareWebSdkUrl } from "@/utils/square/square-config";
import {
  EXCHANGE_RATE_BUYER_MESSAGE,
  EXCHANGE_RATE_ERROR_CODE,
  isCrypto,
  toSmallestUnit,
  ZERO_DECIMAL_CURRENCIES,
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
interface SquareApplePay {
  // Square's Apple Pay has NO attach(): availability is proven by
  // payments.applePay() resolving, and the button is integrator-rendered —
  // its click calls tokenize().
  tokenize: () => Promise<SquareTokenizeResult>;
  destroy?: () => Promise<void>;
}
interface SquarePayments {
  card: () => Promise<SquareCard>;
  // Opaque payment-request handle: paymentRequest() builds it, applePay()
  // consumes it. Only the fields we pass are declared.
  paymentRequest: (options: {
    countryCode: string;
    currencyCode: string;
    total: { amount: string; label: string };
  }) => object;
  applePay: (paymentRequest: object) => Promise<SquareApplePay>;
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
  countryCode,
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
  // Merchant's ISO country for the Apple Pay payment request. Absent (legacy
  // connection, backfill pending) means no Apple Pay button — card still works.
  countryCode?: string;
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
  const paymentsRef = useRef<SquarePayments | null>(null);
  const applePayRef = useRef<SquareApplePay | null>(null);
  const [applePayReady, setApplePayReady] = useState(false);
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
        paymentsRef.current = payments;
        const card = await payments.card();
        if (cancelled) {
          await card.destroy?.();
          return;
        }
        if (containerRef.current) {
          await card.attach(containerRef.current);
        }
        // attach() yields: cleanup may have run while it was in flight, and
        // only now does the card exist — destroy it instead of leaking a live
        // card element and writing state after unmount.
        if (cancelled) {
          await card.destroy?.();
          return;
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
      paymentsRef.current = null;
      const applePay = applePayRef.current;
      applePayRef.current = null;
      applePay?.destroy?.().catch(() => {});
      const card = cardRef.current;
      cardRef.current = null;
      card?.destroy?.().catch(() => {});
    };
  }, [applicationId, locationId, environment]);

  // Apple Pay: availability is proven by payments.applePay(request) resolving
  // (it throws on unsupported browsers/devices or an unverified domain). Any
  // failure silently leaves card entry as the only path. FIAT-ONLY: for
  // sats/BTC carts the server converts at charge time with a live FX quote, so
  // a client-built wallet total couldn't be guaranteed to match the charge.
  useEffect(() => {
    if (loading || !countryCode || isCrypto(currency)) return;
    const payments = paymentsRef.current;
    if (!payments) return;
    let cancelled = false;
    (async () => {
      try {
        // The wallet total must equal what /api/square/create-payment will
        // charge, so reuse the server's OWN canonicalization (toSmallestUnit:
        // Math.ceil to minor units) — toFixed() alone rounds to NEAREST and
        // could under-display the charge (JPY 99.4 -> wallet 99, charged 100).
        const minor = toSmallestUnit(amount, currency);
        const chargeAmount = ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase())
          ? String(minor)
          : (minor / 100).toFixed(2);
        const request = payments.paymentRequest({
          countryCode: countryCode.toUpperCase(),
          currencyCode: currency.toUpperCase(),
          total: {
            amount: chargeAmount,
            label: (productTitle || "Order").slice(0, 64),
          },
        });
        const applePay = await payments.applePay(request);
        if (cancelled) {
          await applePay.destroy?.();
          return;
        }
        applePayRef.current = applePay;
        setApplePayReady(true);
      } catch {
        // Unavailable here — card entry remains as the fallback.
      }
    })();
    return () => {
      cancelled = true;
      // Clear readiness so a failed re-init after a prop change can't leave a
      // dead button rendered over a null instance.
      setApplePayReady(false);
      const applePay = applePayRef.current;
      applePayRef.current = null;
      applePay?.destroy?.().catch(() => {});
    };
  }, [loading, countryCode, amount, currency, productTitle]);

  // Shared post-tokenization charge: the card form and the Apple Pay button
  // both produce a Square nonce, and /api/square/create-payment treats them
  // identically (sourceId is opaque to it).
  const chargeWithToken = async (token: string): Promise<void> => {
    const res = await fetch("/api/square/create-payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId: token,
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
      return;
    }
    onPaymentSuccess(data.paymentId as string);
  };

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
        return;
      }
      await chargeWithToken(result.token);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Payment failed. Please try again.";
      setErrorMessage(msg);
      onPaymentError(msg);
    } finally {
      setIsProcessing(false);
    }
  };

  // Apple Pay button click: tokenize the authorized sheet payment, then run
  // the exact same charge as a keyed-in card.
  const handleApplePayClick = () => {
    const applePay = applePayRef.current;
    if (!applePay || isProcessing) return;
    setIsProcessing(true);
    setErrorMessage(null);
    void (async () => {
      try {
        const result = await applePay.tokenize();
        if (result.status !== "OK" || !result.token) {
          const msg =
            result.errors?.[0]?.message ||
            "Apple Pay could not authorize the payment.";
          setErrorMessage(msg);
          onPaymentError(msg);
          return;
        }
        await chargeWithToken(result.token);
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : "Payment failed. Please try again.";
        setErrorMessage(msg);
        onPaymentError(msg);
      } finally {
        setIsProcessing(false);
      }
    })();
  };

  return (
    <form onSubmit={handleSubmit} className="w-full">
      {/* Square's SDK has no Apple Pay attach(): the button is ours. Rendered
          only after payments.applePay() resolved (device support + verified
          domain). The -apple-pay-button appearance (styles/globals.css) paints
          Apple's native mark in WebKit. */}
      {applePayReady && (
        <button
          type="button"
          aria-label="Pay with Apple Pay"
          onClick={handleApplePayClick}
          disabled={isProcessing}
          className="square-apple-pay-button shadow-neo mb-3"
        />
      )}
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
        Cancel And Return To Checkout
      </button>
    </form>
  );
}
