import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import type { Reader } from "@stripe/stripe-terminal-react-native";

import { computePosCartTotals } from "@self-sown/domain";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
} from "@/components/seller-ui";
import {
  createStripeTerminalConnectionToken,
  createStripeTerminalPaymentIntent,
} from "@/lib/pos-api";
import { usePosCartStore } from "@/lib/pos-cart-store";
import { formatPosAmount, toSmallestUnit } from "@/lib/pos-fx";
import { finalizePosSale } from "@/lib/pos-sale";
import { getStripeTerminalModule } from "@/lib/pos-stripe-terminal";
import { getErrorMessage } from "@/lib/error-utils";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

type Phase =
  | "idle"
  | "discovering"
  | "connecting"
  | "creating"
  | "ready"
  | "processing"
  | "error";

const PHASE_LABELS: Record<Exclude<Phase, "idle" | "error">, string> = {
  discovering: "Looking for Tap to Pay on this device...",
  connecting: "Connecting the card reader...",
  creating: "Creating the card payment...",
  ready: "Ready — ask the buyer to tap their card or phone.",
  processing: "Processing the card...",
};

export default function PosCardScreen() {
  const router = useRouter();
  const session = useSessionStore((state) => state.session);
  const terminalModule = getStripeTerminalModule();

  const tokenProvider = useCallback(async () => {
    if (!session) throw new Error("No session");
    const token = await createStripeTerminalConnectionToken(session);
    return token.secret;
  }, [session]);

  if (!session) return null;

  if (!terminalModule) {
    return (
      <ScreenScrollView>
        <ScreenTitle title="Tap to Pay" />
        <SellerCard title="Not available in this build">
          <Text style={styles.bodyText}>
            Tap to Pay needs the native Stripe Terminal module, which ships with
            the next app build. Use Lightning, a Square link, or cash for now.
          </Text>
          <ActionButton
            label="Back to sale"
            variant="secondary"
            onPress={() => router.back()}
          />
        </SellerCard>
      </ScreenScrollView>
    );
  }

  const Provider = terminalModule.StripeTerminalProvider;
  return (
    <Provider
      tokenProvider={tokenProvider}
      logLevel="none"
      localeConfig={{ type: "cardLanguagePreferenceIfAvailable" }}
    >
      <TerminalCheckout module={terminalModule} />
    </Provider>
  );
}

// Separate component so the module's hook only runs inside the provider.
function TerminalCheckout({
  module,
}: {
  module: NonNullable<ReturnType<typeof getStripeTerminalModule>>;
}) {
  const router = useRouter();
  const session = useSessionStore((state) => state.session);
  const lines = usePosCartStore((state) => state.lines);
  const note = usePosCartStore((state) => state.note);
  const buyerEmail = usePosCartStore((state) => state.buyerEmail);
  const activeSaleId = usePosCartStore((state) => state.activeSaleId);
  const completeSale = usePosCartStore((state) => state.completeSale);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");

  const totals = useMemo(() => {
    try {
      return computePosCartTotals(lines);
    } catch {
      return null;
    }
  }, [lines]);

  const discoveredReadersRef = useRef<Reader.Type[]>([]);
  const {
    discoverReaders,
    connectReader,
    getLocations,
    retrievePaymentIntent,
    collectPaymentMethod,
    confirmPaymentIntent,
  } = module.useStripeTerminal({
    onUpdateDiscoveredReaders: (readers) => {
      discoveredReadersRef.current = readers;
    },
  });

  if (!session || !totals) return null;

  const runSale = async () => {
    if (!activeSaleId) return;
    setError("");
    try {
      setPhase("discovering");
      discoveredReadersRef.current = [];
      const discovered = await discoverReaders({
        discoveryMethod: "tapToPay",
        simulated: false,
      });
      if (discovered.error) throw new Error(discovered.error.message);
      const reader = discoveredReadersRef.current[0];
      if (!reader) {
        throw new Error(
          "Tap to Pay isn't available on this device. Use Lightning or Square instead."
        );
      }

      // Tap to Pay connections require a Terminal location on the seller's
      // connected account (SDK contract, beta.34: locationId is required).
      const locations = await getLocations({});
      const locationId = locations.error
        ? undefined
        : locations.locations?.[0]?.id;
      if (!locationId) {
        throw new Error(
          "No Stripe Terminal location found on your account. Create one in the Stripe Dashboard under Terminal, then try again."
        );
      }

      setPhase("connecting");
      const connected = await connectReader({
        discoveryMethod: "tapToPay",
        reader,
        locationId,
        merchantDisplayName: "Self-sown PoS",
      });
      if (connected.error) throw new Error(connected.error.message);

      setPhase("creating");
      const amountSmallest = toSmallestUnit(totals.total, totals.currency);
      if (!Number.isInteger(amountSmallest) || amountSmallest <= 0) {
        throw new Error("This amount can't be charged by card.");
      }
      const intent = await createStripeTerminalPaymentIntent(session, {
        amountSmallest,
        currency: totals.currency,
        orderId: activeSaleId,
        description: note.trim()
          ? note.trim()
          : `PoS sale ${activeSaleId.slice(0, 8)}`,
      });

      const retrieved = await retrievePaymentIntent(intent.clientSecret);
      if (retrieved.error || !retrieved.paymentIntent) {
        throw new Error(
          retrieved.error?.message ?? "Could not load the card payment."
        );
      }

      setPhase("ready");
      const collected = await collectPaymentMethod({
        paymentIntent: retrieved.paymentIntent,
      });
      if (collected.error || !collected.paymentIntent) {
        throw new Error(collected.error?.message ?? "The card was declined.");
      }

      setPhase("processing");
      const confirmed = await confirmPaymentIntent({
        paymentIntent: collected.paymentIntent,
      });
      if (confirmed.error || !confirmed.paymentIntent) {
        throw new Error(
          confirmed.error?.message ?? "The payment didn't complete."
        );
      }

      const sale = await finalizePosSale({
        session,
        lines,
        method: "card",
        paymentReference: intent.paymentIntentId,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(buyerEmail.trim() ? { buyerEmail: buyerEmail.trim() } : {}),
      });
      completeSale({
        saleId: sale.saleId,
        method: "card",
        reference: intent.paymentIntentId,
        total: totals.total,
        currency: totals.currency,
        itemCount: totals.itemCount,
        ...(buyerEmail.trim() ? { buyerEmail: buyerEmail.trim() } : {}),
      });
      router.replace("/(tabs)/pos/success" as Href);
    } catch (saleError) {
      setPhase("error");
      setError(getErrorMessage(saleError, "The card payment failed."));
    }
  };

  return (
    <ScreenScrollView>
      <ScreenTitle
        title="Tap to Pay"
        description={formatPosAmount(totals.total, totals.currency)}
      />
      <SellerCard title="Card payment">
        {phase !== "idle" && phase !== "error" ? (
          <Text style={styles.statusText}>{PHASE_LABELS[phase]}</Text>
        ) : null}
        {phase === "error" ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : null}
        {phase === "idle" || phase === "error" ? (
          <>
            <View style={styles.buttonGap}>
              <ActionButton
                label={
                  phase === "error"
                    ? "Try again"
                    : `Charge ${formatPosAmount(totals.total, totals.currency)}`
                }
                onPress={() => void runSale()}
              />
            </View>
            <ActionButton
              label="Back to sale"
              variant="secondary"
              onPress={() => router.back()}
            />
          </>
        ) : null}
      </SellerCard>
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  bodyText: {
    fontFamily: sellerFonts.regular,
    color: sellerThemeTokens.mutedText,
    fontSize: 14,
    marginBottom: 12,
  },
  statusText: {
    fontFamily: sellerFonts.semibold,
    color: sellerThemeTokens.text,
    fontSize: 15,
    marginBottom: 12,
  },
  errorText: {
    fontFamily: sellerFonts.semibold,
    color: sellerThemeTokens.danger,
    fontSize: 14,
    marginBottom: 12,
  },
  buttonGap: { marginBottom: 10 },
});
