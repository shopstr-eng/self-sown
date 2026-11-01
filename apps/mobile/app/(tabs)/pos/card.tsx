import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { Share, StyleSheet, Text, View } from "react-native";
import type { Reader } from "@stripe/stripe-terminal-react-native";

import { computePosCartTotals } from "@self-sown/domain";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
} from "@/components/seller-ui";
import { TapToPayEducationModal } from "@/components/tap-to-pay-education";
import { createStripeTerminalPaymentIntent } from "@/lib/pos-api";
import { usePosCartStore } from "@/lib/pos-cart-store";
import { canRetryCardPayment, executeCardPayment } from "@/lib/pos-card-sale";
import { formatPosAmount, toSmallestUnit } from "@/lib/pos-fx";
import { notifyCardPaymentNotApproved } from "@/lib/pos-notifications";
import {
  buildPosReceiptLines,
  formatDeclinedCardReceiptText,
} from "@/lib/pos-receipt";
import { finalizePosSale } from "@/lib/pos-sale";
import { getStripeTerminalModule } from "@/lib/pos-stripe-terminal";
import { awaitPendingTapToPayWarmup } from "@/lib/pos-tap-to-pay";
import {
  createTapToPayEducationGate,
  shouldShowEducationAfterConnect,
  type TapToPayEducationGate,
} from "@/lib/tap-to-pay-education";
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

  // The StripeTerminalProvider is hoisted into pos/_layout.tsx so the SDK
  // initializes (and warms up Tap to Pay) when the Sell tab mounts.
  return <TerminalCheckout module={terminalModule} />;
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
  // Receipt text for a card attempt that reached the reader but was not
  // approved — shareable to the customer per Apple Tap to Pay 5.10.
  const [declinedReceipt, setDeclinedReceipt] = useState<string | null>(null);
  // Set when a charge's outcome is unknown: retrying could double-charge, so
  // the error screen hides "Try again" until the seller checks Stripe.
  const [chargeBlocked, setChargeBlocked] = useState(false);
  // Apple checklist 4.2: the first checkout connect accepts Apple's T&Cs, so
  // the merchant education screens open right there, before the charge
  // continues. The gate releases the paused sale once dismissed.
  const [showEducation, setShowEducation] = useState(false);
  const educationGateRef = useRef<TapToPayEducationGate | null>(null);
  const educationGate = (educationGateRef.current ??=
    createTapToPayEducationGate());

  // Leaving the screen (back nav / unmount) while the first charge is paused
  // on the education modal must release the gate, or runSale hangs forever on
  // a modal that can no longer be dismissed. Cancel, not dismiss: the seller
  // never saw the education, so the next first charge pauses again, and no
  // charge has been created yet at this point.
  useEffect(() => {
    return () => educationGate.cancel();
  }, [educationGate]);

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
    getConnectedReader,
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
    if (!activeSaleId || chargeBlocked) return;
    setError("");
    setDeclinedReceipt(null);
    try {
      // A warmup discovery may still be in flight from the tab mount /
      // foreground warmup (Apple 1.5); starting a second one would error.
      await awaitPendingTapToPayWarmup();

      // The native SDK keeps the Tap to Pay connection alive across screens —
      // e.g. after enabling in Settings or the awareness moment. Reusing it
      // skips discovery/connect entirely, which keeps the tap UI under the
      // one-second target (Apple 5.6) and avoids colliding with the live
      // connection.
      const connectedReader = await getConnectedReader();

      if (!connectedReader) {
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
          // First connect presents Apple's Tap to Pay Terms & Conditions
          // natively — this is the checkout-flow enable path (Apple 5.3/3.7).
          tosAcceptancePermitted: true,
        });
        if (connected.error) throw new Error(connected.error.message);
      }

      // Apple checklist 4.2 requires the merchant education screens before
      // the first charge; they pause the sale until dismissed. The pause is
      // keyed off the per-seller "seen" flag alone — a reused live connection
      // does NOT skip it, because a seller whose earlier attempt was
      // cancelled mid-education still has the connection cached but has
      // never seen the education.
      if (
        await shouldShowEducationAfterConnect({
          pubkey: session?.pubkey ?? null,
        })
      ) {
        setShowEducation(true);
        // "cancelled" = the screen was left mid-education: unwind without
        // charging. No payment intent exists yet, so there is nothing to
        // clean up — just stop before the charge.
        if ((await educationGate.waitForDismissal()) === "cancelled") return;
      }

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

      const payment = await executeCardPayment(
        {
          retrievePaymentIntent,
          collectPaymentMethod,
          confirmPaymentIntent,
          statusOf: (paymentIntent) => paymentIntent.status,
        },
        intent.clientSecret,
        (step) => setPhase(step)
      );

      if (payment.kind !== "approved") {
        if (payment.kind === "not-approved") {
          // The transaction reached the buyer's card and was not approved:
          // the seller gets a local notification in case they backgrounded
          // the app (5.12) and the outcome screen offers a declined-receipt
          // share (5.10).
          setDeclinedReceipt(
            formatDeclinedCardReceiptText({
              total: totals.total,
              currency: totals.currency,
            })
          );
          await notifyCardPaymentNotApproved({
            amountText: formatPosAmount(totals.total, totals.currency),
          });
        }
        // After an unknown post-confirm outcome the charge may have
        // succeeded — block "Try again" so the seller can't double-charge.
        if (!canRetryCardPayment(payment)) setChargeBlocked(true);
        throw new Error(payment.message);
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
        receiptLines: buildPosReceiptLines(lines),
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
        {phase === "error" && declinedReceipt ? (
          <View style={styles.buttonGap}>
            <ActionButton
              label="Share declined receipt"
              variant="secondary"
              onPress={() =>
                void Share.share({ message: declinedReceipt }).catch(() => {})
              }
            />
          </View>
        ) : null}
        {phase === "idle" ? (
          <Text style={styles.bodyText}>
            First time? Charging here turns on Tap to Pay: Apple will ask you to
            accept its Tap to Pay terms before the first charge.
          </Text>
        ) : null}
        {phase === "idle" || phase === "error" ? (
          <>
            {phase === "idle" || !chargeBlocked ? (
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
            ) : null}
            <ActionButton
              label="Back to sale"
              variant="secondary"
              onPress={() => router.back()}
            />
          </>
        ) : null}
      </SellerCard>

      <TapToPayEducationModal
        visible={showEducation}
        onDone={() => {
          setShowEducation(false);
          // Persists "seen" and releases the paused first charge.
          educationGate.dismiss(session?.pubkey ?? null);
        }}
      />
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
