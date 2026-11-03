// Stripe's API rejects non-http(s) redirect URLs (url_invalid), but the
// mobile app completes Stripe flows inside an auth session that must end on a
// selfsown:// deep link. The bounce route (/api/stripe/connect/app-return)
// gives Stripe an https URL and 302s into the app scheme, which the in-app
// auth session intercepts.
const CUSTOM_APP_SCHEMES = ["selfsown:", "milkmarket:"];

export function isCustomAppSchemeUrl(value: string): boolean {
  try {
    return CUSTOM_APP_SCHEMES.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Translate a caller-supplied redirect target into something Stripe accepts:
 * https URLs pass through unchanged; custom-scheme app deep links are wrapped
 * in the platform's https bounce route.
 */
export function toStripeRedirectUrl(value: string, baseUrl: string): string {
  if (!isCustomAppSchemeUrl(value)) return value;
  const bounce = new URL(
    "/api/stripe/connect/app-return",
    `${baseUrl.replace(/\/+$/, "")}/`
  );
  bounce.searchParams.set("to", value);
  return bounce.toString();
}
