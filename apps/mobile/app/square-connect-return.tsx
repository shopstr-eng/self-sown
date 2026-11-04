import { useEffect } from "react";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";

import { ScreenScrollView, ScreenTitle } from "@/components/seller-ui";

export default function SquareConnectReturnScreen() {
  const router = useRouter();
  const { success, error } = useLocalSearchParams<{
    success?: string;
    error?: string;
  }>();

  useEffect(() => {
    const target =
      success === "true"
        ? "/?squareConnectStatus=success"
        : error
          ? `/?squareConnectStatus=error&squareConnectError=${encodeURIComponent(
              error
            )}`
          : "/";

    router.replace(target as Href);
  }, [error, router, success]);

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Square"
        title="Returning to seller dashboard"
        description="Self-sown is handing control back to the native seller workspace."
      />
    </ScreenScrollView>
  );
}
