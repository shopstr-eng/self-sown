import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, type Href } from "expo-router";
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
  loadNwcConnection,
  lookupNwcInvoicePaid,
  makeNwcInvoice,
  parseNwcConnectionString,
  resolveNwcEncryption,
  type NwcConnectionDetails,
  type NwcEncryption,
} from "@/lib/nwc";
import {
  checkCashuQuotePaid,
  claimCashuQuote,
  createCashuMintInvoice,
  recordPendingCashuQuote,
} from "@/lib/pos-cashu";
import { loadAccountPreferences } from "@/lib/account-settings";
import { usePosCartStore } from "@/lib/pos-cart-store";
import { fiatToSats, formatPosAmount, isSatsCurrency } from "@/lib/pos-fx";
import { buildPosReceiptLines } from "@/lib/pos-receipt";
import { finalizePosSale } from "@/lib/pos-sale";
import { getErrorMessage } from "@/lib/error-utils";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

const POLL_INTERVAL_MS = 3_000;
const INVOICE_TIMEOUT_MS = 10 * 60 * 1000;

type Phase = "preparing" | "waiting" | "finishing" | "error";

export default function PosLightningScreen() {
  const router = useRouter();
  const session = useSessionStore((state) => state.session);
  const lines = usePosCartStore((state) => state.lines);
  const note = usePosCartStore((state) => state.note);
  const buyerEmail = usePosCartStore((state) => state.buyerEmail);
  const activeSaleId = usePosCartStore((state) => state.activeSaleId);
  const completeSale = usePosCartStore((state) => state.completeSale);

  const [phase, setPhase] = useState<Phase>("preparing");
  const [error, setError] = useState("");
  const [invoice, setInvoice] = useState("");
  const [amountSats, setAmountSats] = useState<number | null>(null);
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
          method: "lightning",
          paymentReference: reference,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(buyerEmail.trim() ? { buyerEmail: buyerEmail.trim() } : {}),
        });
        if (cancelled) return;
        completeSale({
          saleId: sale.saleId,
          method: "lightning",
          reference,
          total: totals.total,
          currency: totals.currency,
          itemCount: totals.itemCount,
          receiptLines: buildPosReceiptLines(lines),
          ...(buyerEmail.trim() ? { buyerEmail: buyerEmail.trim() } : {}),
        });
        router.replace("/(tabs)/pos/success" as Href);
      } catch (finalizeError) {
        if (!cancelled) {
          setError(
            getErrorMessage(
              finalizeError,
              "Payment arrived but the sale record failed. Check pending records."
            )
          );
          setPhase("error");
        }
      }
    };

    const run = async () => {
      try {
        const sats = isSatsCurrency(totals.currency)
          ? Math.round(totals.total)
          : await fiatToSats(totals.total, totals.currency);
        if (cancelled) return;
        setAmountSats(sats);

        const description = note.trim()
          ? note.trim()
          : `PoS sale ${activeSaleId.slice(0, 8)}`;
        const saved = await loadNwcConnection(session.pubkey);
        if (cancelled) return;

        if (saved) {
          const details: NwcConnectionDetails = parseNwcConnectionString(
            saved.connectionString
          );
          const encryption: NwcEncryption = await resolveNwcEncryption(
            details,
            saved.info
          );
          if (cancelled) return;

          const created = await makeNwcInvoice(details, encryption, {
            amountSats: sats,
            description,
            expirySecs: Math.floor(INVOICE_TIMEOUT_MS / 1000),
          });
          if (cancelled) return;
          setInvoice(created.invoice);
          setPhase("waiting");

          if (!created.paymentHash) {
            throw new Error(
              "The wallet did not return a payment hash, so payment can't be detected."
            );
          }
          const paymentHash = created.paymentHash;
          pollTimer = setInterval(() => {
            void lookupNwcInvoicePaid(details, encryption, paymentHash)
              .then((result) => {
                if (result.paid) {
                  if (pollTimer) clearInterval(pollTimer);
                  if (timeoutTimer) clearTimeout(timeoutTimer);
                  void finish(result.preimage ?? paymentHash);
                }
              })
              .catch(() => {
                // A flaky wallet/relay answer must not kill the poll loop.
              });
          }, POLL_INTERVAL_MS);
        } else {
          // No NWC wallet: fall back to the seller's configured Cashu mint —
          // it issues the BOLT11 invoice and pays out as ecash, claimed into
          // the mobile wallet once the quote settles.
          const preferences = await loadAccountPreferences(session);
          const mintUrl = preferences.mints[0];
          if (!mintUrl) {
            throw new Error(
              "Connect a Lightning wallet or add a Cashu mint in Settings to take Bitcoin payments."
            );
          }
          const created = await createCashuMintInvoice(
            mintUrl,
            sats,
            description
          );
          if (cancelled) return;
          // Persist BEFORE showing the QR: if the app dies after the buyer
          // pays, the sweep on the next PoS open still claims the funds.
          const pending = {
            mintUrl,
            quoteId: created.quoteId,
            amountSats: sats,
            createdAt: Date.now(),
          };
          await recordPendingCashuQuote(session.pubkey, pending);
          setInvoice(created.invoice);
          setPhase("waiting");

          pollTimer = setInterval(() => {
            void checkCashuQuotePaid(mintUrl, created.quoteId)
              .then(async (paid) => {
                if (!paid || finalizedRef.current || cancelled) return;
                if (pollTimer) clearInterval(pollTimer);
                if (timeoutTimer) clearTimeout(timeoutTimer);
                // A failed claim stays pending and is retried by the sweep;
                // the buyer paid, so the sale is recorded either way.
                await claimCashuQuote(session.pubkey, pending).catch(() => {});
                void finish(`cashu:${created.quoteId}`);
              })
              .catch(() => {
                // A flaky mint answer must not kill the poll loop.
              });
          }, POLL_INTERVAL_MS);
        }
        timeoutTimer = setTimeout(() => {
          if (pollTimer) clearInterval(pollTimer);
          if (!finalizedRef.current && !cancelled) {
            setError("The invoice expired without payment.");
            setPhase("error");
          }
        }, INVOICE_TIMEOUT_MS);
      } catch (prepareError) {
        if (!cancelled) {
          setError(
            getErrorMessage(prepareError, "Could not create the invoice.")
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
        title="Lightning payment"
        description={
          totals
            ? `${formatPosAmount(totals.total, totals.currency)}${
                amountSats ? ` ≈ ${amountSats.toLocaleString()} sats` : ""
              }`
            : undefined
        }
      />
      {phase === "preparing" ? (
        <LoadingScreen message="Creating invoice..." />
      ) : null}
      {phase === "waiting" || phase === "finishing" ? (
        <SellerCard title="Buyer scans to pay">
          <View style={styles.qrWrap}>
            <QRCode value={`lightning:${invoice.toUpperCase()}`} size={220} />
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
                setInvoice("");
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
    marginTop: 12,
    fontSize: 14,
  },
  errorText: {
    fontFamily: sellerFonts.semibold,
    color: sellerThemeTokens.danger,
    fontSize: 14,
    marginBottom: 12,
  },
  buttonGap: { marginBottom: 10 },
});
