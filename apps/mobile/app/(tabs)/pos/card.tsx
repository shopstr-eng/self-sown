import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { Alert, Share, StyleSheet, Text, View } from "react-native";
import type { Reader } from "@stripe/stripe-terminal-react-native";

import { computePosCartTotals } from "@self-sown/domain";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
} from "@/components/seller-ui";
import { TapToPayEducationModal } from "@/components/tap-to-pay-education";
import { ApplePayMark } from "@/components/apple-pay-mark";
import { createStripeTerminalPaymentIntent } from "@/lib/pos-api";
import { usePosCartStore } from "@/lib/pos-cart-store";
import { canRetryCardPayment, executeCardPayment } from "@/lib/pos-card-sale";
import { formatPosAmount, toSmallestUnit } from "@/lib/pos-fx";
import { usePosUnseenOutcome } from "@/lib/pos-outcome-store";
import {
  notifyCardPaymentApproved,
  notifyCardPaymentNotApproved,
} from "@/lib/pos-notifications";
import {
  buildPosReceiptLines,
  formatDeclinedCardReceiptText,
} from "@/lib/pos-receipt";
import { finalizePosSale } from "@/lib/pos-sale";
import { getStripeTerminalModule } from "@/lib/pos-stripe-terminal";
import {
  awaitPendingTapToPayWarmup,
  describeTapToPayEnableFailure,
  isSdkNotInitializedError,
} from "@/lib/pos-tap-to-pay";
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
  const navigation = useNavigation();

  // Tab switches do NOT unmount this screen: a seller who taps another tab
  // mid-charge leaves the sale resolving on a screen nobody is watching (the
  // navigation block below only covers back/removal). The shared
  // usePosUnseenOutcome hook tracks focus so a resolution can signal the
  // outcome (Sell-tab badge + notification) and defer its navigation instead
  // of firing router.replace behind the tab the seller is actually looking
  // at. Called below, once allowNavigationRef exists for the deferred
  // navigation pass-through.

  // runSale is a long async chain that outlives renders; every UI update it
  // makes after an await must be gated on the screen still being mounted, or
  // a sale updates a gone screen and the state silently desyncs.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Leaving the screen (back nav / unmount) while the first charge is
      // paused on the education modal must release the gate, or runSale
      // hangs forever on a modal that can no longer be dismissed. Cancel,
      // not dismiss: the seller never saw the education, so the next first
      // charge pauses again. This only ever fires for the pre-charge pause
      // — once a payment intent exists, navigation is blocked below, so the
      // cancel can no longer race a live charge.
      educationGate.cancel();
    };
  }, [educationGate]);

  // DECISION: once a Stripe payment intent exists (creating → ready →
  // processing) the buyer may already have tapped, so back navigation is
  // BLOCKED until the charge resolves. The alternatives are worse: cancelling
  // the collect mid-flight can leave the buyer charged with the sale never
  // recorded (cancelCollectPaymentMethod cannot touch an in-flight confirm),
  // and letting the sale run silently fires navigation from an unmounted
  // screen. Discovery/connect stay unblocked — nothing is charged yet there,
  // and runSale aborts before creating a payment intent if the seller left.
  const chargeInFlight =
    phase === "creating" || phase === "ready" || phase === "processing";

  // Flipped by the "Cancel payment" button, which exists ONLY in the ready
  // phase: cancelling there is safe because collection only reads the card
  // (no capture can have happened yet), and the abandoned PaymentIntent
  // returns to requiresPaymentMethod — unchargeable. Never offered during
  // processing: cancelling an in-flight confirm could leave the buyer
  // charged with the sale unrecorded, exactly what the navigation block
  // above protects against. executeCardPayment consults this ref to tell a
  // seller cancel (which the SDK surfaces as a plain collect error) apart
  // from a decline.
  const cancelRequestedRef = useRef(false);

  useLayoutEffect(() => {
    navigation.setOptions({ gestureEnabled: !chargeInFlight });
  }, [navigation, chargeInFlight]);

  // The block must not trap the screen's OWN success navigation: runSale
  // arms this right before router.replace, and the guard lets that one
  // removal through. Everything else (back button, gesture, hardware back)
  // still hits the alert.
  const allowNavigationRef = useRef(false);
  usePreventRemove(chargeInFlight, ({ data }) => {
    if (allowNavigationRef.current) {
      navigation.dispatch(data.action);
      return;
    }
    Alert.alert(
      "Card payment in progress",
      "Wait for the payment to finish before leaving this screen."
    );
  });

  // Shared tab-switch outcome wiring (focus tracking, Sell-tab badge, and
  // the deferred success navigation): on refocus after an unseen approval,
  // the hook fires the replace itself — arming the same pass-through the
  // immediate path uses, so the charge-in-flight navigation block doesn't
  // swallow that replace.
  const {
    focusedRef,
    blankForDeferredOutcome,
    badgeUnseenFailure,
    deferApprovedOutcome,
  } = usePosUnseenOutcome({
    onDeferredNavigate: () => {
      allowNavigationRef.current = true;
    },
  });

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
    cancelCollectPaymentMethod,
  } = module.useStripeTerminal({
    onUpdateDiscoveredReaders: (readers) => {
      discoveredReadersRef.current = readers;
    },
  });

  if (!session || !totals) return null;

  // A charge that resolved approved while the seller was on another tab keeps
  // this still-mounted screen blank until the refocus effect replaces it with
  // the success screen — never a stale mid-charge phase over an emptied cart
  // (completeSale has already cleared the cart store by then).
  if (blankForDeferredOutcome) return null;

  const runSale = async () => {
    if (!activeSaleId || chargeBlocked) return;
    setError("");
    setDeclinedReceipt(null);
    // A fresh attempt starts with no pending cancel; a stale flag from the
    // previous attempt must not turn a real decline into a silent cancel.
    cancelRequestedRef.current = false;
    // UI updates from the async chain below are gated on the screen still
    // being mounted; once the charge is in flight, finalizePosSale still
    // runs so a succeeded payment is never left unrecorded.
    const setPhaseIfMounted = (next: Phase) => {
      if (mountedRef.current) setPhase(next);
    };
    try {
      // A warmup discovery may still be in flight from the tab mount /
      // foreground warmup (Apple 1.5); starting a second one would error.
      await awaitPendingTapToPayWarmup();
      if (!mountedRef.current) return;

      // The native SDK keeps the Tap to Pay connection alive across screens —
      // e.g. after enabling in Settings or the awareness moment. Reusing it
      // skips discovery/connect entirely, which keeps the tap UI under the
      // one-second target (Apple 5.6) and avoids colliding with the live
      // connection.
      const connectedReader = await getConnectedReader();
      if (!mountedRef.current) return;

      if (!connectedReader) {
        setPhaseIfMounted("discovering");
        discoveredReadersRef.current = [];
        const discovered = await discoverReaders({
          discoveryMethod: "tapToPay",
          simulated: false,
        });
        if (discovered.error) throw new Error(discovered.error.message);
        // Discovery is still pre-charge and unblocked; if the seller left
        // while it ran, stop before connecting or creating anything.
        if (!mountedRef.current) return;
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

        setPhaseIfMounted("connecting");
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
      // The seller can still leave during discovery/connect (nothing charged
      // yet); abort before the education pause or any payment intent exists.
      if (!mountedRef.current) return;

      // Apple checklist 4.2 requires the merchant education screens before
      // the first charge; they pause the sale until dismissed. The pause is
      // keyed off the per-seller "seen" flag alone — a reused live connection
      // does NOT skip it, because a seller whose earlier attempt was
      // cancelled mid-education still has the connection cached but has
      // never seen the education.
      const showEducationFirst = await shouldShowEducationAfterConnect({
        pubkey: session?.pubkey ?? null,
      });
      // The seen-check is an async storage read; if the seller left while it
      // settled (and it returned false — the normal path for an educated
      // seller), execution must NOT fall through to creating a payment intent
      // on a gone screen.
      if (!mountedRef.current) return;
      if (showEducationFirst) {
        setShowEducation(true);
        // "cancelled" = the screen was left mid-education: unwind without
        // charging. No payment intent exists yet, so there is nothing to
        // clean up — just stop before the charge.
        if ((await educationGate.waitForDismissal()) === "cancelled") return;
        // A dismissal that raced the unmount must not resume into a charge.
        if (!mountedRef.current) return;
      }

      setPhaseIfMounted("creating");
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
        (step) => setPhaseIfMounted(step),
        { isCancelRequested: () => cancelRequestedRef.current }
      );

      if (payment.kind !== "approved") {
        if (payment.kind === "not-approved") {
          // The transaction reached the buyer's card and was not approved:
          // the seller gets a local notification in case they backgrounded
          // the app (5.12) and the outcome screen offers a declined-receipt
          // share (5.10). The notification still fires when the screen is
          // gone — it exists for exactly that case.
          if (mountedRef.current) {
            setDeclinedReceipt(
              formatDeclinedCardReceiptText({
                total: totals.total,
                currency: totals.currency,
              })
            );
          }
          await notifyCardPaymentNotApproved({
            amountText: formatPosAmount(totals.total, totals.currency),
          });
        }
        // After an unknown post-confirm outcome the charge may have
        // succeeded — block "Try again" so the seller can't double-charge.
        if (!canRetryCardPayment(payment) && mountedRef.current) {
          setChargeBlocked(true);
        }
        throw new Error(payment.message);
      }

      // The charge succeeded: finalizePosSale + completeSale run even if the
      // screen is somehow gone (app teardown is the only way out mid-charge,
      // since navigation is blocked) so a paid card is never left
      // unrecorded. Only the navigation is mount-gated. The deferred-outcome
      // marker is deliberately NOT armed before this point: a recording
      // failure must land in the error path below, and a seller refocusing
      // while recording is in progress must not navigate to success for a
      // sale that has not been recorded yet.
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
      if (mountedRef.current) {
        // The sale is recorded; decide by focus AT COMPLETION, not at card
        // approval — the seller may have switched tabs during the awaited
        // recording step, and a replace must never fire behind the tab they
        // are looking at.
        if (!focusedRef.current) {
          // deferApprovedOutcome arms the deferred marker synchronously after
          // completeSale so the cart-clearing re-render already sees it and
          // the render gate above stays blank rather than flashing a stale
          // mid-charge state; it also badges the Sell tab. Fire the
          // approved-charge notification too (the in-app banner is suppressed
          // by the foreground handler, so it surfaces if they backgrounded
          // the app entirely). The success navigation itself is deferred to
          // the hook's refocus effect.
          const amountText = formatPosAmount(totals.total, totals.currency);
          deferApprovedOutcome(amountText);
          await notifyCardPaymentApproved({ amountText });
        } else {
          // Arm the guard's pass-through so the charge-in-flight navigation
          // block doesn't swallow the success screen's own replace.
          allowNavigationRef.current = true;
          router.replace("/(tabs)/pos/success" as Href);
        }
      }
    } catch (saleError) {
      if (!mountedRef.current) return;
      // The SDK's opaque "first initialize" error means init's token fetch
      // was refused (no charges-enabled Stripe account) or is still racing —
      // translate it like the enable flow does, never show it verbatim.
      const message = isSdkNotInitializedError(saleError)
        ? (await describeTapToPayEnableFailure(session, saleError)).message
        : getErrorMessage(saleError, "The card payment failed.");
      setPhase("error");
      setError(message);
      // Resolved while the seller is on another tab: the error state waits on
      // this still-mounted screen, but they will not see it until they come
      // back — badge the Sell tab so the failed charge is not silently
      // missed. (A decline additionally fires its Apple 5.12 notification
      // above, which covers the backgrounded-app case.)
      badgeUnseenFailure(
        formatPosAmount(totals.total, totals.currency),
        message
      );
    }
  };

  return (
    <ScreenScrollView>
      <ScreenTitle
        title="Tap to Pay"
        description={formatPosAmount(totals.total, totals.currency)}
      />
      <SellerCard title="Card payment">
        {phase === "ready" ? (
          // Buyer-facing acceptance moment: the buyer is about to tap, so the
          // approved Apple Pay mark (toolkit SVG, unmodified — never a
          // recreated badge) signals wallets are welcome alongside cards.
          <View style={styles.markRow}>
            <ApplePayMark width={52} />
          </View>
        ) : null}
        {phase !== "idle" && phase !== "error" ? (
          <Text style={styles.statusText}>{PHASE_LABELS[phase]}</Text>
        ) : null}
        {phase === "error" ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : null}
        {phase === "ready" ? (
          // The in-screen escape hatch while waiting for the buyer's tap
          // (navigation is still blocked in this phase). The SDK rejects the
          // in-flight collect; executeCardPayment then unwinds to the
          // retryable error state, which also lifts the navigation block. An
          // error from the cancel call means collection already finished, in
          // which case the sale continues normally — nothing to surface.
          <ActionButton
            label="Cancel payment"
            variant="secondary"
            onPress={() => {
              cancelRequestedRef.current = true;
              void cancelCollectPaymentMethod().catch(() => {});
            }}
          />
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
          // A stale dismissal can arrive after unmount (the modal's exit
          // animation completing late); never set state on the gone screen.
          if (mountedRef.current) setShowEducation(false);
          // Persists "seen" and releases the paused first charge.
          educationGate.dismiss(session?.pubkey ?? null);
        }}
      />
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  markRow: {
    alignItems: "center",
    marginBottom: 12,
  },
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
