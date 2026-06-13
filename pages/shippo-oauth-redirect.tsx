import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { Button, Spinner } from "@heroui/react";
import { completeShippoOAuth } from "@/utils/shipping/client-api";

// Shippo redirects here after the seller authorizes the marketplace app
// (registered callback path: /shippo-oauth-redirect). We exchange the
// returned `code` + single-use `state` for a stored connection, then send
// the seller back to Settings → Shipping.
const ShippoOAuthRedirect = () => {
  const router = useRouter();
  const [status, setStatus] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!router.isReady) return;

    const code = (router.query.code as string) || "";
    const state = (router.query.state as string) || "";
    const oauthError = (router.query.error as string) || "";

    if (oauthError) {
      setStatus("error");
      setMessage(
        oauthError === "access_denied"
          ? "You declined to connect your Shippo account."
          : `Shippo returned an error: ${oauthError}`
      );
      return;
    }

    if (!code || !state) {
      setStatus("error");
      setMessage("Missing authorization details from Shippo.");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        await completeShippoOAuth(code, state);
        if (cancelled) return;
        setStatus("done");
        setMessage("Your Shippo account is connected.");
        setTimeout(() => {
          router.replace("/settings/shipping");
        }, 1500);
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setMessage(
          e instanceof Error
            ? e.message
            : "Failed to connect your Shippo account."
        );
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white px-4">
      <div className="shadow-neo w-full max-w-md rounded-md border-2 border-black bg-white p-8 text-center">
        <h1 className="mb-4 text-2xl font-bold text-black">
          Connecting Shippo
        </h1>

        {status === "working" && (
          <div className="flex flex-col items-center gap-3">
            <Spinner />
            <p className="text-sm text-gray-700">
              Finishing your Shippo connection…
            </p>
          </div>
        )}

        {status === "done" && (
          <div className="flex flex-col items-center gap-3">
            <p className="font-semibold text-green-700">{message}</p>
            <p className="text-sm text-gray-600">
              Taking you back to your shipping settings…
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="flex flex-col items-center gap-4">
            <p className="font-semibold text-red-700">{message}</p>
            <Button
              className="bg-primary-yellow border-2 border-black font-semibold text-black"
              onPress={() => router.replace("/settings/shipping")}
            >
              Back to shipping settings
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ShippoOAuthRedirect;
