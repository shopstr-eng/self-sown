import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { Button, Spinner } from "@heroui/react";
import { completeSquareOAuth } from "@/utils/square/client-api";

// Square redirects here after the seller authorizes the marketplace app
// (registered callback path: /square-oauth-redirect). We exchange the returned
// `code` + single-use `state` for a stored connection, then send the seller
// back to Settings → Payments. Flows started from the mobile app carry an
// "app_" prefix in the state (set by /api/square/oauth/start) and bounce back
// into the app scheme instead — the in-app auth session intercepts the deep
// link and closes.
const APP_RETURN_URL = "selfsown://square-connect-return";

const SquareOAuthRedirect = () => {
  const router = useRouter();
  const [status, setStatus] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!router.isReady) return;

    const code = (router.query.code as string) || "";
    const state = (router.query.state as string) || "";
    const oauthError = (router.query.error as string) || "";
    const returnToApp = state.startsWith("app_");
    const bounceToApp = (query = "") => {
      window.location.assign(`${APP_RETURN_URL}${query}`);
    };

    if (oauthError) {
      // A decline from an app flow bounces straight back; the app re-reads
      // the (unchanged) connection state.
      if (returnToApp) {
        bounceToApp();
        return;
      }
      setStatus("error");
      setMessage(
        oauthError === "access_denied"
          ? "You declined to connect your Square account."
          : `Square returned an error: ${oauthError}`
      );
      return;
    }

    if (!code || !state) {
      setStatus("error");
      setMessage("Missing authorization details from Square.");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        await completeSquareOAuth(code, state);
        if (cancelled) return;
        if (returnToApp) {
          bounceToApp("?success=true");
          return;
        }
        setStatus("done");
        setMessage("Your Square account is connected.");
        setTimeout(() => {
          router.replace("/settings/payments");
        }, 1500);
      } catch (e) {
        if (cancelled) return;
        const errorMessage =
          e instanceof Error
            ? e.message
            : "Failed to connect your Square account.";
        if (returnToApp) {
          // Keep the server's message (e.g. the Stripe-already-connected XOR
          // refusal) visible by handing it to the app.
          bounceToApp(`?error=${encodeURIComponent(errorMessage)}`);
          return;
        }
        setStatus("error");
        setMessage(errorMessage);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router.isReady]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white px-4">
      <div className="shadow-neo w-full max-w-md rounded-md border-2 border-black bg-white p-8 text-center">
        <h1 className="mb-4 text-2xl font-bold text-black">
          Connecting Square
        </h1>

        {status === "working" && (
          <div className="flex flex-col items-center gap-3">
            <Spinner />
            <p className="text-sm text-gray-700">
              Finishing your Square connection…
            </p>
          </div>
        )}

        {status === "done" && (
          <div className="flex flex-col items-center gap-3">
            <p className="font-semibold text-green-700">{message}</p>
            <p className="text-sm text-gray-600">
              Taking you back to your payment settings…
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="flex flex-col items-center gap-4">
            <p className="font-semibold text-red-700">{message}</p>
            <Button
              className="bg-primary-yellow border-2 border-black font-semibold text-black"
              onPress={() => void router.replace("/settings/payments")}
            >
              Back To Payment Settings
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SquareOAuthRedirect;
