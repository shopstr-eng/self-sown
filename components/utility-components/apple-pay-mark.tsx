// Shared renderer for Apple's approved Apple Pay acceptance mark. Apple's
// marketing rules forbid recreated or altered artwork: the SVG is served
// byte-for-byte unmodified from public/tap-to-pay/logo/ (copies of
// apps/mobile/assets/tap-to-pay/logo/) and the only allowed transformation
// is uniform scaling, so the <img> pins width and lets height follow the
// toolkit aspect ratio (no height, no crop, no recolor, no overlay).
// Parity + wiring guards: __tests__/pages/apple-pay-marks.test.ts.

export const APPLE_PAY_MARK_SRC =
  "/tap-to-pay/logo/Apple_Pay_Mark_RGB_041619.svg";

// Matches the ways a manual fiat payment handle can name the wallet
// ("applepay", "apple pay", "apple-pay", "Apple Pay", ...). Kept case- and
// separator-insensitive so seller-entered variants all resolve to the mark.
export const isApplePayLabel = (label?: string | null): boolean =>
  !!label && label.toLowerCase().replace(/[\s_-]+/g, "") === "applepay";

export const ApplePayMark = ({
  width = 40,
  className,
}: {
  width?: number;
  className?: string;
}) => (
  // The approved Apple Pay acceptance mark from the Tap to Pay on iPhone
  // Marketing Toolkit; only its rendered size is ours.
  <img
    src={APPLE_PAY_MARK_SRC}
    alt="Apple Pay"
    width={width}
    className={className ? `h-auto ${className}` : "h-auto"}
  />
);

// Renders a payment-method label buyer-facing, appending the toolkit mark
// whenever the label names Apple Pay so acceptance is never advertised as
// bare text (the compliance gap the FAQ mark fixed on the marketing pages).
export const PaymentOptionLabel = ({
  label,
  markWidth = 32,
  className,
}: {
  label: string;
  markWidth?: number;
  className?: string;
}) => (
  <span
    className={
      className
        ? `inline-flex items-center gap-2 ${className}`
        : "inline-flex items-center gap-2"
    }
  >
    <span>{label}</span>
    {isApplePayLabel(label) ? <ApplePayMark width={markWidth} /> : null}
  </span>
);
