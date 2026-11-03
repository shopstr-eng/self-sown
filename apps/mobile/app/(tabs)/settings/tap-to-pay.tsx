import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import type { Reader } from "@stripe/stripe-terminal-react-native";

import type { SellerSession } from "@self-sown/domain";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
} from "@/components/seller-ui";
import { TapToPayDisclaimerFooter } from "@/components/tap-to-pay-disclaimer";
import { TapToPayEducationModal } from "@/components/tap-to-pay-education";
import { ApplePayMark } from "@/components/apple-pay-mark";
import { TapToPayProvider } from "@/components/tap-to-pay-provider";
import { fetchPosPaymentMethods } from "@/lib/pos-api";
import { getStripeTerminalModule } from "@/lib/pos-stripe-terminal";
import {
  TAP_TO_PAY_CONNECT_STRIPE_MESSAGE,
  awaitPendingTapToPayWarmup,
  describeTapToPayEnableFailure,
  enableTapToPay,
} from "@/lib/pos-tap-to-pay";
import {
  hasSeenTapToPayEducation,
  markTapToPayEducationSeen,
} from "@/lib/tap-to-pay-education";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

// Apple checklist 3.6: Tap to Pay must be enableable outside the checkout
// flow — this Settings screen is that path. The education copy doubles as
// the in-app merchant education resource Apple asks for in Settings/Help
// (4.3/4.5/4.6).

type EnablePhase = "idle" | "discovering" | "connecting" | "done" | "error";

export default function TapToPaySettingsScreen() {
  const session = useSessionStore((state) => state.session);

  if (!session) return null;

  return (
    <TapToPayProvider session={session}>
      <TapToPaySettings session={session} />
    </TapToPayProvider>
  );
}

function TapToPaySettings({ session }: { session: SellerSession }) {
  const router = useRouter();
  const terminalModule = getStripeTerminalModule();
  const [phase, setPhase] = useState<EnablePhase>("idle");
  const [error, setError] = useState("");
  // True when enablement failed because the seller has no charges-enabled
  // Stripe account — drives the "Open payment settings" action below.
  const [needsStripeConnect, setNeedsStripeConnect] = useState(false);
  // Card-charges status for the enable gate; null while loading (fail open:
  // the enable attempt's error path re-checks and maps the failure).
  const [stripeChargesEnabled, setStripeChargesEnabled] = useState<
    boolean | null
  >(null);
  // Apple checklist 4.2: education opens right after T&C acceptance (the
  // enable flow below). 4.3: it also stays reopenable from here anytime.
  const [showEducation, setShowEducation] = useState(false);

  const discoveredReadersRef = useRef<Reader.Type[]>([]);
  // The provider above wraps this screen whenever the module exists; when it
  // doesn't (web export, older dev builds) the enable UI below is gated off
  // before these handlers can run.
  const terminal = terminalModule?.useStripeTerminal({
    onUpdateDiscoveredReaders: (readers) => {
      discoveredReadersRef.current = readers;
    },
  });

  // The SDK's init eagerly fetches a connection token, which 403s for sellers
  // without a charges-enabled Stripe account — every enable attempt then dies
  // with the cryptic "First initialize the Stripe Terminal SDK" error. Gate
  // the button up front so those sellers get the fix instead.
  useEffect(() => {
    let cancelled = false;
    fetchPosPaymentMethods(session)
      .then((methods) => {
        if (!cancelled) setStripeChargesEnabled(methods.stripe.chargesEnabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (!session) return null;

  const enable = async () => {
    if (!terminal) return;
    setError("");
    setNeedsStripeConnect(false);
    setPhase("discovering");
    try {
      await awaitPendingTapToPayWarmup();
      discoveredReadersRef.current = [];
      const result = await enableTapToPay(
        {
          getConnectedReader: terminal.getConnectedReader,
          discoverReaders: terminal.discoverReaders,
          getLocations: terminal.getLocations,
          connectReader: terminal.connectReader,
        },
        () => discoveredReadersRef.current,
        (nextPhase) => setPhase(nextPhase)
      );
      if (!result.ok) {
        const failure = await describeTapToPayEnableFailure(
          session,
          result.error
        );
        setPhase("error");
        setError(failure.message);
        setNeedsStripeConnect(failure.needsStripeConnect);
        return;
      }
      setPhase("done");
      if (!(await hasSeenTapToPayEducation(session.pubkey))) {
        setShowEducation(true);
      }
    } catch (enableError) {
      const failure = await describeTapToPayEnableFailure(
        session,
        enableError
      );
      setPhase("error");
      setError(failure.message);
      setNeedsStripeConnect(failure.needsStripeConnect);
    }
  };

  return (
    <ScreenScrollView>
      <ScreenTitle
        title="Tap to Pay on iPhone"
        description="Take contactless cards, Apple Pay, and other digital wallets in person — no extra hardware."
      />
      {/* Apple's acceptance rule: where the app advertises Apple Pay
          acceptance (the description above), show Apple's own mark — the
          toolkit SVG, unmodified — never a recreated badge. */}
      <View style={styles.markRow}>
        <ApplePayMark width={48} />
      </View>

      {!terminalModule ? (
        <SellerCard title="Not available in this build">
          <Text style={styles.bodyText}>
            Tap to Pay needs the native Stripe Terminal module, which ships with
            the next app build.
          </Text>
        </SellerCard>
      ) : (
        <SellerCard
          title="Enable Tap to Pay"
          description="Turn it on once here, or the first time you charge a card from the Sell tab. Apple will ask you to accept its Tap to Pay terms."
        >
          {phase === "discovering" || phase === "connecting" ? (
            <Text style={styles.statusText}>
              {phase === "discovering"
                ? "Preparing Tap to Pay on this iPhone..."
                : "Accept Apple's terms to finish setup..."}
            </Text>
          ) : null}
          {phase === "error" ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : null}
          {stripeChargesEnabled === false && phase === "idle" ? (
            <Text style={styles.statusText}>
              {TAP_TO_PAY_CONNECT_STRIPE_MESSAGE}
            </Text>
          ) : null}
          {phase === "done" ? (
            <Text style={styles.successText}>
              Tap to Pay is ready on this iPhone.
            </Text>
          ) : null}
          {phase !== "done" ? (
            <>
              {stripeChargesEnabled === false ||
              (phase === "error" && needsStripeConnect) ? (
                <View style={styles.connectCta}>
                  <ActionButton
                    label="Open payment settings"
                    variant="secondary"
                    onPress={() => router.push("/(tabs)" as Href)}
                  />
                </View>
              ) : null}
              <ActionButton
                label={phase === "error" ? "Try again" : "Turn on Tap to Pay"}
                loading={phase === "discovering" || phase === "connecting"}
                disabled={stripeChargesEnabled === false}
                onPress={() => void enable()}
              />
            </>
          ) : null}
        </SellerCard>
      )}

      <SellerCard title="How it works">
        <Text style={styles.bodyText}>
          • Add items on the Sell tab, tap Review sale, then choose Tap to Pay
          on iPhone.{"\n"}• Ask the buyer to hold their contactless card,
          iPhone, Apple Watch, or other digital wallet near the top of your
          iPhone.{"\n"}• The screen confirms when the card is read, then shows
          whether the payment was approved or declined.{"\n"}• If a card can't
          be read, you can still take Lightning, a Square link, or cash from the
          same sale.
        </Text>
        <Text style={styles.bodyText}>
          Card charges land in your connected Stripe account. Standard Stripe
          processing fees apply.
        </Text>
      </SellerCard>

      <SellerCard
        title="Tap to Pay education"
        description="The how-to screens shown after setup — contactless cards, Apple Pay and wallets, PIN entry, and what to do when a card can't be read."
      >
        <ActionButton
          label="Review the education"
          variant="secondary"
          onPress={() => setShowEducation(true)}
        />
      </SellerCard>

      {/* This screen pitches Tap to Pay and names Apple Pay, so Apple's rules
          require the legal disclaimer here too: the short form clicks through
          to the product page with the full disclaimer, and the Apple Pay
          service notice rides along. */}
      <TapToPayDisclaimerFooter mentionsApplePay />

      <TapToPayEducationModal
        visible={showEducation}
        onDone={() => {
          setShowEducation(false);
          void markTapToPayEducationSeen(session.pubkey);
        }}
      />
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  markRow: {
    alignItems: "center",
    marginBottom: 16,
  },
  connectCta: {
    marginBottom: 10,
  },
  bodyText: {
    fontFamily: sellerFonts.regular,
    color: sellerThemeTokens.mutedText,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 12,
  },
  statusText: {
    fontFamily: sellerFonts.semibold,
    color: sellerThemeTokens.text,
    fontSize: 14,
    marginBottom: 12,
  },
  errorText: {
    fontFamily: sellerFonts.semibold,
    color: sellerThemeTokens.danger,
    fontSize: 14,
    marginBottom: 12,
  },
  successText: {
    fontFamily: sellerFonts.semibold,
    color: sellerThemeTokens.success,
    fontSize: 14,
    marginBottom: 12,
  },
});
