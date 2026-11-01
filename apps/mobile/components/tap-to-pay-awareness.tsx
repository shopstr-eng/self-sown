import { useEffect, useRef, useState } from "react";
import { Modal, StyleSheet, Text, View } from "react-native";
import type { Reader } from "@stripe/stripe-terminal-react-native";

import type { SellerSession } from "@self-sown/domain";

import { ActionButton } from "@/components/seller-ui";
import { fetchPosPaymentMethods } from "@/lib/pos-api";
import { getStripeTerminalModule } from "@/lib/pos-stripe-terminal";
import {
  awaitPendingTapToPayWarmup,
  checkTapToPayDeviceSupport,
  computeTapToPayEligibility,
  enableTapToPay,
  hasSeenTapToPayAwareness,
  markTapToPayAwarenessSeen,
} from "@/lib/pos-tap-to-pay";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

// Apple Tap to Pay checklist 3.1/3.2/3.3: a full-screen awareness moment,
// shown at least once to every eligible signed-in seller, with a direct
// action to enable. Eligibility = native module shipped + Stripe card
// charges enabled + device supports Tap to Pay. The "shown once" marker is
// per seller pubkey so a shared device still reaches every account.
// Apple-approved artwork from the Tap to Pay Marketing Toolkit can replace
// the text hero here without touching the flow.

type AwarenessPhase = "pitch" | "discovering" | "connecting" | "done" | "error";

const ENABLE_PHASE_LABELS: Record<"discovering" | "connecting", string> = {
  discovering: "Preparing Tap to Pay on this iPhone...",
  connecting: "Accept Apple's terms to finish setup...",
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

  const discoveredReadersRef = useRef<Reader.Type[]>([]);
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
      const deadline = Date.now() + 15_000;
      while (!cancelled && !getIsInitialized() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (cancelled || !getIsInitialized()) return;
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
    setPhase("discovering");
    try {
      // A warmup discovery may still be in flight; a second concurrent
      // discovery would error, so let it settle first.
      await awaitPendingTapToPayWarmup();
      discoveredReadersRef.current = [];
      const result = await enableTapToPay(
        { getConnectedReader, discoverReaders, getLocations, connectReader },
        () => discoveredReadersRef.current,
        (nextPhase) => setPhase(nextPhase)
      );
      if (!result.ok) {
        setPhase("error");
        setError(result.error ?? "Could not enable Tap to Pay.");
        return;
      }
      setPhase("done");
    } catch (enableError) {
      setPhase("error");
      setError(
        enableError instanceof Error
          ? enableError.message
          : "Could not enable Tap to Pay."
      );
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={dismiss}
    >
      <View style={styles.container}>
        <View style={styles.hero}>
          <Text style={styles.heroSymbol}>)))</Text>
        </View>
        <Text style={styles.title}>Tap to Pay on iPhone</Text>
        <Text style={styles.body}>
          Accept contactless cards, Apple Pay, and other digital wallets in
          person — right on this iPhone, no extra hardware.
        </Text>
        <Text style={styles.body}>
          The first time you turn it on, Apple will ask you to accept the Tap
          to Pay terms. After that, taking a card payment is one tap from the
          Sell tab.
        </Text>

        {phase === "discovering" || phase === "connecting" ? (
          <Text style={styles.statusText}>{ENABLE_PHASE_LABELS[phase]}</Text>
        ) : null}
        {phase === "error" ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : null}
        {phase === "done" ? (
          <Text style={styles.successText}>
            Tap to Pay is ready. Your next in-person sale can take a card with
            a tap.
          </Text>
        ) : null}

        <View style={styles.actions}>
          {phase === "pitch" || phase === "error" ? (
            <>
              <View style={styles.actionGap}>
                <ActionButton
                  label={
                    phase === "error" ? "Try again" : "Turn on Tap to Pay"
                  }
                  onPress={() => void enable()}
                />
              </View>
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
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: sellerThemeTokens.background,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  hero: {
    alignSelf: "center",
    width: 96,
    height: 96,
    borderWidth: 3,
    borderColor: sellerThemeTokens.black,
    borderRadius: 20,
    backgroundColor: sellerThemeTokens.surface,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  heroSymbol: {
    fontFamily: sellerFonts.extrabold,
    fontSize: 34,
    color: sellerThemeTokens.primary,
    transform: [{ rotate: "90deg" }],
  },
  title: {
    fontFamily: sellerFonts.extrabold,
    fontSize: 26,
    color: sellerThemeTokens.text,
    textAlign: "center",
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
