import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, type Href } from "expo-router";
import * as Linking from "expo-linking";
import { StyleSheet, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";

import { computePosCartTotals } from "@self-sown/domain";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
} from "@/components/seller-ui";
import LoadingScreen from "@/components/loading-screen";
import {
  createSquarePosPaymentLink,
  fetchSquarePosLinkStatus,
} from "@/lib/pos-api";
import { usePosUnseenOutcome } from "@/lib/pos-card-outcome-store";
import { usePosCartStore } from "@/lib/pos-cart-store";
import { formatPosAmount, toSmallestUnit } from "@/lib/pos-fx";
import { buildPosReceiptLines } from "@/lib/pos-receipt";
import { finalizePosSale } from "@/lib/pos-sale";
import { getErrorMessage } from "@/lib/error-utils";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

const POLL_INTERVAL_MS = 4_000;
const LINK_TIMEOUT_MS = 15 * 60 * 1000;

type Phase = "preparing" | "waiting" | "finishing" | "error";

export default function PosSquareScreen() {
  const router = useRouter();
  const session = useSessionStore((state) => state.session);
  const lines = usePosCartStore((state) => state.lines);
  const note = usePosCartStore((state) => state.note);
  const buyerEmail = usePosCartStore((state) => state.buyerEmail);
  const activeSaleId = usePosCartStore((state) => state.activeSaleId);
  const completeSale = usePosCartStore((state) => state.completeSale);

  const [phase, setPhase] = useState<Phase>("preparing");
  const [error, setError] = useState("");
  const [checkoutUrl, setCheckoutUrl] = useState("");
  const [attempt, setAttempt] = useState(0);
  const finalizedRef = useRef(false);

  // Tab switches do NOT unmount this screen (same as the Tap to Pay card
  // screen): a seller who taps another tab while the buyer is on the hosted
  // checkout leaves the poll resolving on a screen nobody is watching. The
  // shared usePosUnseenOutcome hook tracks focus so a resolution can badge
  // the Sell tab and defer its navigation instead of firing router.replace
  // behind the tab the seller is actually looking at.
  const {
    focusedRef,
    pendingOutcomeRef,
    badgeUnseenFailure,
    deferApprovedOutcome,
  } = usePosUnseenOutcome();

  const totals = useMemo(() => {
    try {
      return computePosCartTotals(lines);
    } catch {
      return null;
    }
  }, [lines]);

  useEffect(() => {
    if (!session || !totals || !activeSaleId) return;
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    // A failure that resolves while the seller is on another tab: the error
    // state waits on this still-mounted screen, but they will not see it
    // until they come back — badgeUnseenFailure badges the Sell tab so it is
    // not silently missed.
    const badgeFailure = (message: string) =>
      badgeUnseenFailure(
        formatPosAmount(totals.total, totals.currency),
        message
      );

    const finish = async (reference: string) => {
      if (finalizedRef.current || cancelled) return;
      finalizedRef.current = true;
      setPhase("finishing");
      try {
        const sale = await finalizePosSale({
          session,
          lines,
          method: "card",
          paymentReference: reference,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(buyerEmail.trim() ? { buyerEmail: buyerEmail.trim() } : {}),
        });
        if (cancelled) return;
        completeSale({
          saleId: sale.saleId,
          method: "card",
          reference,
          total: totals.total,
          currency: totals.currency,
          itemCount: totals.itemCount,
          receiptLines: buildPosReceiptLines(lines),
          ...(buyerEmail.trim() ? { buyerEmail: buyerEmail.trim() } : {}),
        });
        // Focus is sampled AT COMPLETION, not at payment detection — the
        // seller may have switched tabs during the awaited recording step,
        // and a replace must never fire behind the tab they are looking at.
        if (!focusedRef.current) {
          // deferApprovedOutcome arms the deferred marker synchronously
          // after completeSale so the cart-clearing re-render already sees
          // it and the render gate below stays blank rather than flashing a
          // stale waiting state; it also badges the Sell tab. The success
          // navigation itself is deferred to the hook's refocus effect.
          deferApprovedOutcome(formatPosAmount(totals.total, totals.currency));
        } else {
          router.replace("/(tabs)/pos/success" as Href);
        }
      } catch (finalizeError) {
        if (!cancelled) {
          const message = getErrorMessage(
            finalizeError,
            "Payment arrived but the sale record failed."
          );
          setError(message);
          setPhase("error");
          badgeFailure(message);
        }
      }
    };

    const run = async () => {
      try {
        const amountSmallest = toSmallestUnit(totals.total, totals.currency);
        if (!Number.isInteger(amountSmallest) || amountSmallest <= 0) {
          throw new Error("This amount can't be charged by card.");
        }
        const link = await createSquarePosPaymentLink(session, {
          amountSmallest,
          currency: totals.currency,
          orderId: activeSaleId,
          title:
            lines.length === 1
              ? lines[0]!.item.title
              : `In-person sale (${totals.itemCount} items)`,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        if (cancelled) return;
        setCheckoutUrl(link.url);
        setPhase("waiting");

        pollTimer = setInterval(() => {
          void fetchSquarePosLinkStatus(session, {
            linkId: link.linkId,
            orderId: link.orderId,
          })
            .then((status) => {
              if (status.paid) {
                if (pollTimer) clearInterval(pollTimer);
                if (timeoutTimer) clearTimeout(timeoutTimer);
                void finish(status.paymentId ?? link.linkId);
              }
            })
            .catch(() => {
              // Transient status failures must not kill the poll loop.
            });
        }, POLL_INTERVAL_MS);
        timeoutTimer = setTimeout(() => {
          if (pollTimer) clearInterval(pollTimer);
          if (!finalizedRef.current && !cancelled) {
            const message = "The checkout link expired without payment.";
            setError(message);
            setPhase("error");
            badgeFailure(message);
          }
        }, LINK_TIMEOUT_MS);
      } catch (prepareError) {
        if (!cancelled) {
          const message = getErrorMessage(
            prepareError,
            "Could not create the Square checkout link."
          );
          setError(message);
          setPhase("error");
          badgeFailure(message);
        }
      }
    };
    void run();

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.pubkey, activeSaleId, attempt]);

  if (!session || !totals) return null;

  // A payment that resolved while the seller was on another tab keeps this
  // still-mounted screen blank until the refocus effect replaces it with the
  // success screen — never a stale waiting state over an emptied cart
  // (completeSale has already cleared the cart store by then).
  if (pendingOutcomeRef.current) return null;

  return (
    <ScreenScrollView>
      <ScreenTitle
        title="Card via Square"
        description={formatPosAmount(totals.total, totals.currency)}
      />
      {phase === "preparing" ? (
        <LoadingScreen message="Creating checkout link..." />
      ) : null}
      {phase === "waiting" || phase === "finishing" ? (
        <SellerCard title="Buyer scans to pay by card">
          <View style={styles.qrWrap}>
            <QRCode value={checkoutUrl} size={220} />
          </View>
          <View style={styles.buttonGap}>
            <ActionButton
              label="Open checkout link"
              variant="secondary"
              onPress={() => void Linking.openURL(checkoutUrl)}
            />
          </View>
          <Text style={styles.waitingText}>
            {phase === "finishing"
              ? "Payment received — recording the sale..."
              : "Waiting for payment…"}
          </Text>
        </SellerCard>
      ) : null}
      {phase === "error" ? (
        <SellerCard title="Payment failed">
          <Text style={styles.errorText}>{error}</Text>
          <View style={styles.buttonGap}>
            <ActionButton
              label="Try again"
              onPress={() => {
                finalizedRef.current = false;
                setPhase("preparing");
                setError("");
                setCheckoutUrl("");
                setAttempt((value) => value + 1);
              }}
            />
          </View>
          <ActionButton
            label="Back to sale"
            variant="secondary"
            onPress={() => router.back()}
          />
        </SellerCard>
      ) : null}
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  qrWrap: {
    alignItems: "center",
    padding: 16,
    backgroundColor: "#FFFFFF",
    borderRadius: 8,
    alignSelf: "center",
  },
  waitingText: {
    fontFamily: sellerFonts.semibold,
    color: sellerThemeTokens.mutedText,
    textAlign: "center",
    marginTop: 4,
    fontSize: 14,
  },
  errorText: {
    fontFamily: sellerFonts.semibold,
    color: sellerThemeTokens.danger,
    fontSize: 14,
    marginBottom: 12,
  },
  buttonGap: { marginTop: 12 },
});
