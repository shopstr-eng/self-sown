import * as Linking from "expo-linking";

export type SquareConnectCallbackStatus = "success" | "error";

export function createSquareConnectRedirectBaseUrl() {
  return Linking.createURL("/square-connect-return", {
    scheme: "selfsown",
  });
}

// Parse the deep link the /square-oauth-redirect page bounces to after an
// app-started Square OAuth flow (marked server-side by the "app_" state
// prefix). A bare URL means the seller declined at Square; ?error= carries
// the server's failure message (e.g. the Stripe-already-connected refusal).
export function getSquareConnectCallbackStatus(
  input?: string | null
): { status: SquareConnectCallbackStatus; errorMessage?: string } | null {
  if (!input) {
    return null;
  }

  const parsed = Linking.parse(input);
  if (parsed.queryParams?.success === "true") {
    return { status: "success" };
  }

  const error = parsed.queryParams?.error;
  if (typeof error === "string" && error) {
    return { status: "error", errorMessage: error };
  }

  return null;
}
