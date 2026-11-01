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
import { usePosCartStore } from "@/lib/pos-cart-store";
import { formatPosAmount, toSmallestUnit } from "@/lib/pos-fx";
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
          ...(buyerEmail.trim() ? { buyerEmail: buyerEmail.trim() } : {}),
        });
        router.replace("/(tabs)/pos/success" as Href);
      } catch (finalizeError) {
        if (!cancelled) {
          setError(
            getErrorMessage(
              finalizeError,
              "Payment arrived but the sale record failed."
            )
          );
          setPhase("error");
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
            setError("The checkout link expired without payment.");
            setPhase("error");
          }
        }, LINK_TIMEOUT_MS);
      } catch (prepareError) {
        if (!cancelled) {
          setError(
            getErrorMessage(
              prepareError,
              "Could not create the Square checkout link."
            )
          );
          setPhase("error");
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
