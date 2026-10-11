import { useEffect } from "react";
import { useRouter, type Href } from "expo-router";

import { ScreenScrollView, ScreenTitle } from "@/components/seller-ui";

// Landing route for the selfsown://pro-return deep link that hosted Stripe
// Checkout redirects to after payment. The membership screen refetches status
// itself when the browser sheet closes, so this just hands control back.
export default function ProReturnScreen() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/settings/membership" as Href);
  }, [router]);

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Membership"
        title="Returning to the app"
        description="Stripe is handing control back to the seller workspace."
      />
    </ScreenScrollView>
  );
}
