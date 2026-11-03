import * as Linking from "expo-linking";

export type StripeConnectCallbackStatus = "success" | "refresh";

export function createStripeConnectRedirectBaseUrl() {
  return Linking.createURL("/stripe-connect-return", {
    scheme: "selfsown",
  });
}

export function createStripeConnectRedirectUrl(
  status?: StripeConnectCallbackStatus
) {
  return Linking.createURL("/stripe-connect-return", {
    scheme: "selfsown",
    queryParams:
      status === "success"
        ? { success: "true" }
        : status === "refresh"
          ? { refresh: "true" }
          : undefined,
  });
}

export function getStripeConnectCallbackStatus(
  input?: string | null
): StripeConnectCallbackStatus | null {
  if (!input) {
    return null;
  }

  const parsed = Linking.parse(input);
  const success = parsed.queryParams?.success;
  if (success === "true") {
    return "success";
  }

  const refresh = parsed.queryParams?.refresh;
  if (refresh === "true") {
    return "refresh";
  }

  return null;
}

// Stripe can take a few seconds to flip charges_enabled after hosted
// onboarding redirects back to the app, so a single immediate refetch can
// return the stale pre-connect state — the dashboard then still says
// "not connected" and the seller taps Connect again (re-answering Stripe's
// form) before it updates. Poll briefly until charges flip or the budget
// runs out; callers pass attempts: 1 when polling can't help (e.g. Stripe
// asked for more information, so charges can't be live yet).
export async function refetchStripeConnectStatusUntilSettled<
  T extends { chargesEnabled?: boolean }
>(
  refetch: () => Promise<{ data?: T | undefined; error?: unknown }>,
  options?: { attempts?: number; delayMs?: number }
): Promise<{ data?: T | undefined; error?: unknown }> {
  const attempts = Math.max(1, options?.attempts ?? 4);
  const delayMs = options?.delayMs ?? 2_000;

  let latest = await refetch();
  for (
    let attempt = 1;
    attempt < attempts && !latest.error && !latest.data?.chargesEnabled;
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    latest = await refetch();
  }
  return latest;
}
