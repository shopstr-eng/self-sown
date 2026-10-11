import { useRouter } from "expo-router";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
} from "@/components/seller-ui";
import { useSessionStore } from "@/stores/session-store";

export default function SettingsIndexScreen() {
  const router = useRouter();
  const session = useSessionStore((state) => state.session);

  if (!session) {
    return null;
  }

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Settings"
        title="Profile & account"
        description="Edit your market profile, manage account preferences, and keep saved addresses handy."
      />

      <SellerCard
        title="Market profile"
        description="Your public Nostr profile: display name, picture, Lightning address, fiat payment options, and donation."
      >
        <ActionButton
          label="Edit market profile"
          onPress={() => router.push("/settings/market-profile")}
          variant="secondary"
        />
      </SellerCard>

      <SellerCard
        title="Account & preferences"
        description="Back up your keys, manage Cashu mints, and configure relays and media servers."
      >
        <ActionButton
          label="Open account settings"
          onPress={() => router.push("/settings/account")}
          variant="secondary"
        />
      </SellerCard>

      <SellerCard
        title="Saved addresses"
        description="Shipping addresses stored on this device that you can reuse during checkout."
      >
        <ActionButton
          label="Manage saved addresses"
          onPress={() => router.push("/settings/addresses")}
          variant="secondary"
        />
      </SellerCard>

      <SellerCard
        title="Membership"
        description="See your current plan, upgrade to Herd, or manage billing via Stripe's secure checkout."
      >
        <ActionButton
          label="View membership"
          onPress={() => router.push("/settings/membership")}
          variant="secondary"
        />
      </SellerCard>
    </ScreenScrollView>
  );
}
