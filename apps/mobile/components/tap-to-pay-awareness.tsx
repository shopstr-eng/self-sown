import { useEffect, useRef, useState } from "react";
import {
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter, type Href } from "expo-router";
import type { Reader } from "@stripe/stripe-terminal-react-native";

import type { SellerSession } from "@self-sown/domain";

import { ActionButton } from "@/components/seller-ui";
import { ApplePayLogo } from "@/components/apple-pay-mark";
import { TapToPayDisclaimerFooter } from "@/components/tap-to-pay-disclaimer";
import { TapToPayEducationModal } from "@/components/tap-to-pay-education";
import { fetchPosPaymentMethods } from "@/lib/pos-api";
import { tapToPayHeroArtwork } from "@/lib/tap-to-pay-artwork";
import { getStripeTerminalModule } from "@/lib/pos-stripe-terminal";
import {
  awaitPendingTapToPayWarmup,
  checkTapToPayDeviceSupport,
  computeTapToPayEligibility,
  describeTapToPayEnableFailure,
  enableTapToPay,
  hasSeenTapToPayAwareness,
  markTapToPayAwarenessSeen,
} from "@/lib/pos-tap-to-pay";
import {
  hasSeenTapToPayEducation,
  markTapToPayEducationSeen,
  presentAppleTapToPayEducation,
} from "@/lib/tap-to-pay-education";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

// Apple Tap to Pay checklist 3.1/3.2/3.3: a full-screen awareness moment,
// shown at least once to every eligible signed-in seller, with a direct
// action to enable. Eligibility = native module shipped + Stripe card
// charges enabled + device supports Tap to Pay. The "shown once" marker is
// per seller pubkey so a shared device still reaches every account.
// The hero is Apple's own approved Tap to Pay on iPhone artwork (Req 4.4 —
// never self-made iPhone imagery); see lib/tap-to-pay-artwork.ts.
// The pitch copy below paraphrases Apple's approved marketing copy blocks —
// keep wording aligned with packages/domain/src/tap-to-pay-marketing-copy.ts (Apple's rules
// cap how far we can stray, and legal disclaimers apply to marketing
// placements).

type AwarenessPhase = "pitch" | "discovering" | "connecting" | "done" | "error";

// iOS wording is Apple-review-mandated — keep it byte-identical. Android has
// no such mandate, so it gets device-neutral wording (no iPhone/Apple terms).
const ENABLE_PHASE_LABELS: Record<"discovering" | "connecting", string> = {
  discovering: "Preparing Tap to Pay on this iPhone...",
  connecting: "Accept Apple's terms to finish setup...",
};
const ENABLE_PHASE_LABELS_ANDROID: Record<
  "discovering" | "connecting",
  string
> = {
  discovering: "Preparing Tap to Pay on this phone...",
  connecting: "Accept the Tap to Pay terms to finish setup...",
};

export function TapToPayAwarenessMoment({
  session,
}: {
  session: SellerSession | null;
}) {
  const terminalModule = getStripeTerminalModule();
  if (!terminalModule || !session) return null;
  return <AwarenessInner module={terminalModule} session={session} />;
}

// Separate component so the module's hook only runs inside the provider.
function AwarenessInner({
  module,
  session,
}: {
  module: NonNullable<ReturnType<typeof getStripeTerminalModule>>;
  session: SellerSession;
}) {
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<AwarenessPhase>("pitch");
  const [error, setError] = useState("");
  // True when enablement failed because the seller has no charges-enabled
  // Stripe account — swaps "Maybe later" for a path to payment settings.
  const [needsStripeConnect, setNeedsStripeConnect] = useState(false);
  const router = useRouter();
  // Apple checklist 4.2: education screens open right after the seller
  // accepts Apple's Terms & Conditions inside the enable flow.
  const [showEducation, setShowEducation] = useState(false);

  const discoveredReadersRef = useRef<Reader.Type[]>([]);
  // iOS keeps the Apple-review-mandated copy/artwork/disclaimer verbatim;
  // Android has no such requirement and Apple branding rules make iPhone
  // wording and marks wrong there, so Android renders a device-neutral pitch.
  const isAndroid = Platform.OS === "android";
  const hero = tapToPayHeroArtwork(Platform.OS);
  const {
    discoverReaders,
    getLocations,
    connectReader,
    getConnectedReader,
    supportsReadersOfType,
    getIsInitialized,
  } = module.useStripeTerminal({
    onUpdateDiscoveredReaders: (readers) => {
      discoveredReadersRef.current = readers;
    },
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (await hasSeenTapToPayAwareness(session.pubkey)) return;
      const methods = await fetchPosPaymentMethods(session).catch(() => null);
      // Wait briefly for SDK init so the device-support probe doesn't throw
      // on a cold start; the next tab visit retries if it isn't ready yet.
      // getIsInitialized itself can throw while the native side is down —
      // treat a throw as "not yet" so the poll never rejects unhandled.
      const isInitialized = () => {
        try {
          return getIsInitialized();
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 15_000;
      while (!cancelled && !isInitialized() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (cancelled || !isInitialized()) return;
      const deviceSupported = await checkTapToPayDeviceSupport({
        supportsReadersOfType,
      });
      const eligible = computeTapToPayEligibility({
        moduleAvailable: true,
        chargesEnabled: Boolean(methods?.stripe.chargesEnabled),
        deviceSupported,
      });
      if (!cancelled && eligible) setVisible(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [session, getIsInitialized, supportsReadersOfType]);

  const dismiss = () => {
    setVisible(false);
    void markTapToPayAwarenessSeen(session.pubkey);
  };

  const enable = async () => {
    setError("");
    setNeedsStripeConnect(false);
    setPhase("discovering");
    try {
      // A warmup discovery may still be in flight; a second concurrent
      // discovery would error, so let it settle first.
      await awaitPendingTapToPayWarmup();
      discoveredReadersRef.current = [];
      const result = await enableTapToPay(
        { getConnectedReader, discoverReaders, getLocations, connectReader },
        () => discoveredReadersRef.current,
        (nextPhase) => setPhase(nextPhase),
        { platformOS: Platform.OS }
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
        // Req 4.1 (required since the guide's iOS 18 rev): Apple's own
        // ProximityReaderDiscovery sheet is the education on iOS 18+; the
        // custom screens below are the fallback everywhere else.
        if (await presentAppleTapToPayEducation()) {
          void markTapToPayEducationSeen(session.pubkey);
        } else {
          setShowEducation(true);
        }
      }
    } catch (enableError) {
      const failure = await describeTapToPayEnableFailure(session, enableError);
      setPhase("error");
      setError(failure.message);
      setNeedsStripeConnect(failure.needsStripeConnect);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={dismiss}
    >
      {/* Scrollable so the legal disclaimer and the enable/dismiss buttons
          stay reachable on small phones even with the artwork + pitch above. */}
      <ScrollView contentContainerStyle={styles.container}>
        {hero ? (
          <Image
            source={hero.image}
            style={styles.hero}
            resizeMode="contain"
            accessibilityLabel={hero.accessibilityLabel}
          />
        ) : null}
        <Text style={styles.title}>
          {isAndroid ? "Tap to Pay" : "Tap to Pay on iPhone"}
        </Text>
        {/* The iOS pitch names Apple Pay, so Apple's marks guidance requires
            the approved lockup there (toolkit SVG, unmodified — no crop,
            recolor, or overlay), not a recreated badge. The Android pitch
            never names Apple Pay, so it renders no mark. */}
        {!isAndroid ? (
          <View style={styles.lockupRow}>
            <ApplePayLogo width={104} />
          </View>
        ) : null}
        <Text style={styles.body}>
          {isAndroid
            ? "Accept contactless cards and digital wallets in person — right on this phone, no extra hardware."
            : "Accept contactless cards, Apple Pay, and other digital wallets in person — right on this iPhone, no extra hardware."}
        </Text>
        <Text style={styles.body}>
          {isAndroid
            ? "The first time you turn it on, you'll be asked to accept the Tap to Pay terms. After that, taking a card payment is one tap from the Sell tab."
            : "The first time you turn it on, Apple will ask you to accept the Tap to Pay terms. After that, taking a card payment is one tap from the Sell tab."}
        </Text>

        {/* Apple requires a legal disclaimer on every Tap to Pay placement.
            This pitch names Apple Pay, so the Apple Pay service disclaimer
            rides along; the short disclaimer clicks through to the product
            page showing the full disclaimer. Android has no Apple disclaimer
            requirement (the pitch names no Apple services), so no footer. */}
        {!isAndroid ? <TapToPayDisclaimerFooter mentionsApplePay /> : null}

        {phase === "discovering" || phase === "connecting" ? (
          <Text style={styles.statusText}>
            {
              (isAndroid ? ENABLE_PHASE_LABELS_ANDROID : ENABLE_PHASE_LABELS)[
                phase
              ]
            }
          </Text>
        ) : null}
        {phase === "error" ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : null}
        {phase === "done" ? (
          <Text style={styles.successText}>
            Tap to Pay is ready. Your next in-person sale can take a card with a
            tap.
          </Text>
        ) : null}

        <View style={styles.actions}>
          {phase === "pitch" || phase === "error" ? (
            <>
              <View style={styles.actionGap}>
                <ActionButton
                  label={phase === "error" ? "Try again" : "Turn on Tap to Pay"}
                  onPress={() => void enable()}
                />
              </View>
              {phase === "error" && needsStripeConnect ? (
                <View style={styles.actionGap}>
                  <ActionButton
                    label="Open payment settings"
                    variant="secondary"
                    onPress={() => {
                      dismiss();
                      router.push("/(tabs)" as Href);
                    }}
                  />
                </View>
              ) : null}
              <ActionButton
                label="Maybe later"
                variant="secondary"
                onPress={dismiss}
              />
            </>
          ) : null}
          {phase === "done" ? (
            <ActionButton label="Done" onPress={dismiss} />
          ) : null}
        </View>

        <TapToPayEducationModal
          visible={showEducation}
          onDone={() => {
            setShowEducation(false);
            void markTapToPayEducationSeen(session.pubkey);
            dismiss();
          }}
        />
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: sellerThemeTokens.background,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  // Apple's approved artwork renders unmodified (no border/crop) per the Tap
  // to Pay marketing rules — only size and placement are ours.
  hero: {
    alignSelf: "center",
    width: "100%",
    height: 200,
    marginBottom: 24,
  },
  title: {
    fontFamily: sellerFonts.extrabold,
    fontSize: 26,
    color: sellerThemeTokens.text,
    textAlign: "center",
    marginBottom: 16,
  },
  // Unmodified toolkit lockup — only size and placement are ours (same rule
  // as the hero above).
  lockupRow: {
    alignItems: "center",
    marginBottom: 16,
  },
  body: {
    fontFamily: sellerFonts.regular,
    fontSize: 15,
    lineHeight: 22,
    color: sellerThemeTokens.mutedText,
    textAlign: "center",
    marginBottom: 12,
  },
  statusText: {
    fontFamily: sellerFonts.semibold,
    fontSize: 14,
    color: sellerThemeTokens.text,
    textAlign: "center",
    marginTop: 8,
  },
  errorText: {
    fontFamily: sellerFonts.semibold,
    fontSize: 14,
    color: sellerThemeTokens.danger,
    textAlign: "center",
    marginTop: 8,
  },
  successText: {
    fontFamily: sellerFonts.semibold,
    fontSize: 14,
    color: sellerThemeTokens.success,
    textAlign: "center",
    marginTop: 8,
  },
  actions: { marginTop: 28 },
  actionGap: { marginBottom: 10 },
});
