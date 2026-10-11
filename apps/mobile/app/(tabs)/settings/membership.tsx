import { useCallback, useEffect, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
  StatusPill,
} from "@/components/seller-ui";
import LoadingScreen from "@/components/loading-screen";
import { getErrorMessage } from "@/lib/error-utils";
import {
  createProCheckoutRedirectBaseUrl,
  createProCheckoutSession,
  createProPortalSession,
  describeMembership,
  formatProCoverage,
  formatProDate,
  formatProMoney,
  getMobileMembershipView,
  getProBillingHistory,
  getProCheckoutCallbackStatus,
  membershipOffers,
  proHistoryMethodLabel,
  proHistoryTermLabel,
  syncProMembership,
  waitForMembershipEntitlement,
  PRO_ANNUAL_PRICE_CENTS,
  PRO_MONTHLY_PRICE_CENTS,
  WRANGLER_LIFETIME_PRICE_CENTS,
  type MobileMembershipView,
  type MobileProBillingHistoryItem,
  type ProCheckoutPlan,
} from "@/lib/pro-membership";
import { useSessionStore } from "@/stores/session-store";
import { sellerThemeTokens } from "@/theme/tokens";

function formatPrice(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

export default function MembershipScreen() {
  const session = useSessionStore((state) => state.session);

  const [membership, setMembership] = useState<MobileMembershipView | null>(
    null
  );
  const [history, setHistory] = useState<MobileProBillingHistoryItem[] | null>(
    null
  );
  const [historyError, setHistoryError] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const pubkey = session?.pubkey;

  // History is a separate signed read; a failure there must not blank the
  // membership status, so it keeps its own state and error.
  const refreshHistory = useCallback(async () => {
    if (!session) return;
    try {
      setHistory(await getProBillingHistory(session));
      setHistoryError("");
    } catch (caughtError) {
      setHistoryError(
        getErrorMessage(caughtError, "Billing history could not be loaded.")
      );
    }
  }, [session]);

  const refresh = useCallback(async () => {
    if (!pubkey) {
      setIsLoaded(true);
      return;
    }
    try {
      const view = await getMobileMembershipView(pubkey);
      setMembership(view);
      setLoadError("");
    } catch (caughtError) {
      setLoadError(
        getErrorMessage(caughtError, "Membership status could not be loaded.")
      );
    } finally {
      setIsLoaded(true);
    }
    await refreshHistory();
  }, [pubkey, refreshHistory]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The browser sheet doesn't blur this screen in navigation terms, so
  // refetch when the app itself returns to the foreground after checkout.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        void refresh();
      }
    });
    return () => subscription.remove();
  }, [refresh]);

  if (!session) {
    return null;
  }

  if (!isLoaded) {
    return <LoadingScreen message="Loading membership..." />;
  }

  const summary = membership ? describeMembership(membership) : null;
  const offers = membership ? membershipOffers(membership) : null;
  const isBusy = pendingAction !== null;
  const showUpgrade = Boolean(
    offers && (offers.subscriptionPlans || offers.lifetime)
  );

  const settleAfterCheckout = async () => {
    setActionMessage("Confirming your payment with Stripe...");
    await syncProMembership(session);
    const settled = await waitForMembershipEntitlement(session.pubkey);
    if (settled) {
      setMembership(settled);
    }
    setActionMessage(
      settled?.isPro
        ? "Welcome to Herd! Your membership is active."
        : "Payment received — Stripe is still confirming it. Pull up this screen again in a moment."
    );
  };

  const handleUpgrade = async (plan: ProCheckoutPlan) => {
    setPendingAction(plan);
    setActionError("");
    setActionMessage("");
    try {
      const { url } = await createProCheckoutSession(session, plan);
      if (!url) {
        throw new Error("Stripe did not return a checkout page.");
      }
      const result = await WebBrowser.openAuthSessionAsync(
        url,
        createProCheckoutRedirectBaseUrl()
      );
      // The auth session resolves with type "success" for BOTH the success
      // and cancel deep links (both match the redirect base) — only the
      // status param distinguishes a paid checkout from a canceled one.
      const callbackStatus =
        result.type === "success"
          ? getProCheckoutCallbackStatus(result.url)
          : null;
      if (callbackStatus === "success") {
        await settleAfterCheckout();
      } else {
        setActionMessage("Checkout closed — no changes were made.");
      }
      await refresh();
    } catch (caughtError) {
      setActionError(
        getErrorMessage(caughtError, "Checkout could not be started.")
      );
    } finally {
      setPendingAction(null);
    }
  };

  const handleOpenReceipt = async (url: string) => {
    try {
      await WebBrowser.openBrowserAsync(url);
    } catch (caughtError) {
      setActionError(
        getErrorMessage(caughtError, "The receipt could not be opened.")
      );
    }
  };

  const handleManage = async () => {
    setPendingAction("portal");
    setActionError("");
    setActionMessage("");
    try {
      const { url } = await createProPortalSession(session);
      if (!url) {
        throw new Error("Stripe did not return a billing portal page.");
      }
      // The portal only accepts https return URLs, so the sheet won't
      // deep-link back; refetch when the seller dismisses it.
      await WebBrowser.openBrowserAsync(url);
      await refresh();
      setActionMessage("Membership status refreshed.");
    } catch (caughtError) {
      setActionError(
        getErrorMessage(caughtError, "The billing portal could not be opened.")
      );
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Settings"
        title="Membership"
        description="Buy or manage your Herd membership. Card payment is handled securely by Stripe in a browser sheet — nothing is stored in the app."
      />

      <SellerCard
        title="Current plan"
        description={
          loadError ||
          (summary?.detail ?? "Membership status is unavailable right now.")
        }
      >
        {summary ? (
          <View style={styles.statusRow}>
            <StatusPill tone={summary.tone} label={summary.label} />
          </View>
        ) : null}
        <ActionButton
          label="Refresh status"
          onPress={() => void refresh()}
          variant="secondary"
          disabled={isBusy}
        />
      </SellerCard>

      {showUpgrade && offers ? (
        <SellerCard
          title={
            membership?.isTrialing ? "Keep Herd after your trial" : "Upgrade to Herd"
          }
          description={
            membership?.isTrialing
              ? "Add a payment now and Herd features carry on without interruption when the trial ends. Card payment is handled securely by Stripe."
              : offers.subscriptionPlans
                ? "Pick a plan to continue to Stripe's secure checkout. Access turns on automatically once payment completes."
                : "Switch to a one-time Wrangler lifetime purchase via Stripe's secure checkout — no more renewals."
          }
        >
          {offers.subscriptionPlans ? (
            <>
              <ActionButton
                label={`Herd Monthly — ${formatPrice(PRO_MONTHLY_PRICE_CENTS)}/mo`}
                onPress={() => void handleUpgrade("monthly")}
                loading={pendingAction === "monthly"}
                disabled={isBusy && pendingAction !== "monthly"}
              />
              <ActionButton
                label={`Herd Yearly — ${formatPrice(PRO_ANNUAL_PRICE_CENTS)}/yr`}
                onPress={() => void handleUpgrade("yearly")}
                loading={pendingAction === "yearly"}
                disabled={isBusy && pendingAction !== "yearly"}
              />
            </>
          ) : null}
          {offers.lifetime ? (
            <ActionButton
              label={`Wrangler Lifetime — ${formatPrice(WRANGLER_LIFETIME_PRICE_CENTS)} once`}
              onPress={() => void handleUpgrade("lifetime")}
              loading={pendingAction === "lifetime"}
              disabled={isBusy && pendingAction !== "lifetime"}
              variant={offers.subscriptionPlans ? "secondary" : "primary"}
            />
          ) : null}
        </SellerCard>
      ) : null}

      {history && history.length > 0 ? (
        <SellerCard
          title="Billing history"
          description="Your past membership charges, newest first."
        >
          {history.map((item) => {
            const coverage = formatProCoverage(
              item.coverageStart,
              item.coverageEnd
            );
            return (
              <View
                key={`${item.source}-${item.id}`}
                style={styles.historyRow}
              >
                <View style={styles.historyRowHeader}>
                  <Text style={styles.historyAmount}>
                    {formatProMoney(item.amountCents, item.currency)}
                  </Text>
                  <Text style={styles.historyMeta}>
                    {proHistoryTermLabel(item)} ·{" "}
                    {proHistoryMethodLabel(item.method)}
                  </Text>
                </View>
                <Text style={styles.historyMeta}>
                  {formatProDate(item.paidAt) ?? "—"}
                  {coverage ? ` · covers ${coverage}` : ""}
                </Text>
                {item.receiptUrl || item.invoicePdfUrl ? (
                  <View style={styles.receiptRow}>
                    {item.receiptUrl ? (
                      <ActionButton
                        label="View receipt"
                        onPress={() =>
                          void handleOpenReceipt(item.receiptUrl as string)
                        }
                        variant="secondary"
                        disabled={isBusy}
                      />
                    ) : null}
                    {item.invoicePdfUrl ? (
                      <ActionButton
                        label="Invoice PDF"
                        onPress={() =>
                          void handleOpenReceipt(item.invoicePdfUrl as string)
                        }
                        variant="secondary"
                        disabled={isBusy}
                      />
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}
        </SellerCard>
      ) : null}

      {historyError ? (
        <SellerCard title="Billing history" description={historyError}>
          <ActionButton
            label="Try again"
            onPress={() => void refreshHistory()}
            variant="secondary"
            disabled={isBusy}
          />
        </SellerCard>
      ) : null}

      {offers?.portal ? (
        <SellerCard
          title="Manage membership"
          description="Update your card, download receipts, or cancel in Stripe's billing portal."
        >
          <ActionButton
            label="Open billing portal"
            onPress={() => void handleManage()}
            loading={pendingAction === "portal"}
            disabled={isBusy && pendingAction !== "portal"}
            variant="secondary"
          />
        </SellerCard>
      ) : null}

      {actionMessage ? (
        <Text style={styles.message}>{actionMessage}</Text>
      ) : null}
      {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  statusRow: {
    flexDirection: "row",
  },
  historyRow: {
    borderTopWidth: 1,
    borderTopColor: sellerThemeTokens.border,
    gap: 4,
    paddingVertical: 12,
  },
  historyRowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  historyAmount: {
    color: sellerThemeTokens.text,
    fontWeight: "800",
    fontSize: 16,
  },
  historyMeta: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
  },
  receiptRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 4,
  },
  message: {
    color: sellerThemeTokens.text,
    fontWeight: "600",
    textAlign: "center",
  },
  error: {
    color: sellerThemeTokens.danger,
    fontWeight: "700",
    textAlign: "center",
  },
});
