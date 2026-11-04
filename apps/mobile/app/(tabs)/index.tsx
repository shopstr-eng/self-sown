import { NotificationSettings } from "@/components/notification-settings";
import * as WebBrowser from "expo-web-browser";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useEffect, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  createSignedSquareOAuthAuthEvent,
  createSignedStripeConnectAuthEvent,
} from "@self-sown/nostr";
import { STRIPE_CONNECT_COUNTRIES } from "@self-sown/api-client";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
  StatusPill,
} from "@/components/seller-ui";
import { useSellerBootstrap } from "@/hooks/use-seller-bootstrap";
import { mobileApiClient } from "@/lib/api-client";
import { getErrorMessage } from "@/lib/error-utils";
import { clearPrivateSellerOrderQueries } from "@/lib/order-query";
import { queryClient } from "@/lib/query-client";
import {
  createSquareConnectRedirectBaseUrl,
  getSquareConnectCallbackStatus,
} from "@/lib/square-connect";
import {
  createStripeConnectRedirectBaseUrl,
  createStripeConnectRedirectUrl,
  getStripeConnectCallbackStatus,
  refetchStripeConnectStatusUntilSettled,
  type StripeConnectCallbackStatus,
} from "@/lib/stripe-connect";
import { requestTerminalSdkInit } from "@/lib/terminal-init-signal";
import { useSessionStore } from "@/stores/session-store";
import { sellerThemeTokens } from "@/theme/tokens";

export default function DashboardScreen() {
  const router = useRouter();
  const { squareConnectError, squareConnectStatus, stripeConnectStatus } =
    useLocalSearchParams<{
      squareConnectError?: string;
      squareConnectStatus?: string;
      stripeConnectStatus?: string;
    }>();
  const session = useSessionStore((state) => state.session);
  const clearSession = useSessionStore((state) => state.clearSession);
  const {
    listingsQuery,
    notificationEmailQuery,
    profileQuery,
    shopProfile,
    squareStatusQuery,
    stripeStatusQuery,
  } = useSellerBootstrap(session);

  const [stripeActionLoading, setStripeActionLoading] = useState(false);
  const [stripeActionError, setStripeActionError] = useState("");
  const [stripeActionMessage, setStripeActionMessage] = useState("");
  const [squareActionLoading, setSquareActionLoading] = useState(false);
  const [squareActionError, setSquareActionError] = useState("");
  const [squareActionMessage, setSquareActionMessage] = useState("");
  const [signOutError, setSignOutError] = useState("");
  const [stripeCountry, setStripeCountry] = useState("US");
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);

  useEffect(() => {
    const callbackStatus =
      stripeConnectStatus === "success" || stripeConnectStatus === "refresh"
        ? (stripeConnectStatus as StripeConnectCallbackStatus)
        : null;

    if (!callbackStatus || !session) {
      return;
    }

    let active = true;

    const handleStripeCallback = async () => {
      setStripeActionLoading(true);
      setStripeActionError("");
      setStripeActionMessage(
        callbackStatus === "success"
          ? "Returned from Stripe. Refreshing seller payout status..."
          : "Stripe asked to refresh onboarding details. Updating seller status..."
      );

      const result = await refetchStripeConnectStatusUntilSettled(
        () => stripeStatusQuery.refetch(),
        // A "refresh" return means Stripe still needs more information, so
        // charges can't be live yet — skip the polling budget.
        callbackStatus === "refresh" ? { attempts: 1 } : undefined
      );
      if (!active) {
        return;
      }

      if (result.error) {
        setStripeActionError(
          getErrorMessage(
            result.error,
            "Stripe Connect status could not be refreshed."
          )
        );
        setStripeActionMessage("");
      } else if (callbackStatus === "success") {
        if (result.data?.chargesEnabled) {
          // Charges confirmed live: wake any already-mounted Terminal
          // provider (e.g. the Sell tab's) so the SDK initializes now
          // instead of on the next provider remount.
          requestTerminalSdkInit();
        }
        setStripeActionMessage(
          result.data?.chargesEnabled
            ? "Stripe onboarding returned to the app. Card-payment status is now refreshed."
            : "Returned from Stripe. Stripe setup is still pending completion."
        );
      } else {
        setStripeActionError(
          "Stripe onboarding still needs more information. Tap Connect Stripe to continue."
        );
        setStripeActionMessage("");
      }

      router.replace("/" as Href);
      setStripeActionLoading(false);
    };

    handleStripeCallback().catch((caughtError) => {
      if (!active) {
        return;
      }

      setStripeActionError(
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to refresh Stripe Connect status."
      );
      setStripeActionMessage("");
      setStripeActionLoading(false);
      router.replace("/" as Href);
    });

    return () => {
      active = false;
    };
  }, [router, session, stripeConnectStatus, stripeStatusQuery]);

  // Cold-open path: the /square-connect-return deep-link route forwards here
  // when the auth session didn't intercept the bounce (e.g. the flow finished
  // in an external browser).
  useEffect(() => {
    if (!squareConnectStatus || !session) {
      return;
    }

    let active = true;

    const handleSquareCallback = async () => {
      if (squareConnectStatus === "error") {
        setSquareActionError(
          squareConnectError || "Square connection failed. Try again."
        );
      } else if (squareConnectStatus === "success") {
        setSquareActionLoading(true);
        setSquareActionError("");
        setSquareActionMessage(
          "Returned from Square. Refreshing connection status..."
        );
        const result = await squareStatusQuery.refetch();
        if (!active) {
          return;
        }
        if (result.error) {
          setSquareActionError(
            getErrorMessage(
              result.error,
              "Square connection status could not be refreshed."
            )
          );
          setSquareActionMessage("");
        } else {
          setSquareActionMessage(
            result.data?.connected
              ? "Your Square account is connected. Online card checkout is enabled."
              : "Returned from Square. Connection is still pending."
          );
        }
        setSquareActionLoading(false);
      }

      router.replace("/" as Href);
    };

    handleSquareCallback().catch((caughtError) => {
      if (!active) {
        return;
      }
      setSquareActionError(
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to refresh Square connection status."
      );
      setSquareActionMessage("");
      setSquareActionLoading(false);
      router.replace("/" as Href);
    });

    return () => {
      active = false;
    };
  }, [
    router,
    session,
    squareConnectError,
    squareConnectStatus,
    squareStatusQuery,
  ]);

  if (!session) {
    return null;
  }

  const listingCount = listingsQuery.data?.length ?? 0;
  const stripeStatus = stripeStatusQuery.data;
  const storefrontLoadError =
    profileQuery.error ?? notificationEmailQuery.error ?? null;
  const storefrontLoadErrorMessage = storefrontLoadError
    ? getErrorMessage(
        storefrontLoadError,
        "Vendor storefront data could not be loaded."
      )
    : "";
  const listingsErrorMessage = listingsQuery.error
    ? getErrorMessage(
        listingsQuery.error,
        "Vendor listings could not be loaded right now."
      )
    : "";
  const stripeStatusErrorMessage = stripeStatusQuery.error
    ? getErrorMessage(
        stripeStatusQuery.error,
        "Stripe Connect status could not be loaded."
      )
    : "";
  const setupItems = [
    { label: "Vendor session ready", complete: true },
    {
      label: "Stall basics saved",
      complete: Boolean(shopProfile?.content.name.trim()),
    },
    {
      label: "First listing published",
      complete: Boolean(listingsQuery.data?.length),
    },
    {
      label: "Notification email added",
      complete: Boolean(shopProfile?.notificationEmail ?? session.email),
    },
    {
      label: "Stripe onboarding complete",
      complete: Boolean(stripeStatus?.chargesEnabled),
    },
  ];
  const completedCount = setupItems.filter((item) => item.complete).length;

  const stripeTone =
    stripeStatus?.chargesEnabled === true
      ? "success"
      : stripeStatus?.hasAccount
        ? "warning"
        : "neutral";
  const stripeLabel =
    stripeStatus?.chargesEnabled === true
      ? "Card payments live"
      : stripeStatus?.hasAccount
        ? "Finish Stripe onboarding"
        : "Stripe not connected";

  const squareStatus = squareStatusQuery.data;
  const squareConnected = squareStatus?.connected === true;
  // Fail-closed display: only offer Square when the server says it's
  // configured (matches the web settings page).
  const squareConfigured = squareStatus?.configured === true;
  const squareStatusErrorMessage = squareStatusQuery.error
    ? getErrorMessage(
        squareStatusQuery.error,
        "Square connection status could not be loaded."
      )
    : "";

  const handleRefreshSellerData = async () => {
    await Promise.allSettled([
      profileQuery.refetch(),
      notificationEmailQuery.refetch(),
      listingsQuery.refetch(),
    ]);
  };

  const handleRefreshStripeStatus = async () => {
    setStripeActionError("");
    setStripeActionMessage("");

    try {
      const result = await stripeStatusQuery.refetch();
      if (result.error) {
        throw result.error;
      }
    } catch (caughtError) {
      setStripeActionError(
        getErrorMessage(
          caughtError,
          "Stripe Connect status could not be refreshed."
        )
      );
    }
  };

  const handleStripeConnect = async () => {
    setStripeActionLoading(true);
    setStripeActionError("");
    setStripeActionMessage("");

    try {
      const createAccountSignedEvent = createSignedStripeConnectAuthEvent(
        session,
        { method: "POST", path: "/api/stripe/connect/create-account" }
      );
      const account = await mobileApiClient.createStripeConnectAccount({
        pubkey: session.pubkey,
        signedEvent: createAccountSignedEvent,
        country: stripeCountry,
      });
      const createLinkSignedEvent = createSignedStripeConnectAuthEvent(
        session,
        {
          method: "POST",
          path: "/api/stripe/connect/create-account-link",
        }
      );
      const redirectBaseUrl = createStripeConnectRedirectBaseUrl();
      const link = await mobileApiClient.createStripeConnectAccountLink({
        accountId: account.accountId,
        pubkey: session.pubkey,
        signedEvent: createLinkSignedEvent,
        returnUrl: createStripeConnectRedirectUrl("success"),
        refreshUrl: createStripeConnectRedirectUrl("refresh"),
      });
      const result = await WebBrowser.openAuthSessionAsync(
        link.url,
        redirectBaseUrl
      );

      if (result.type === "cancel" || result.type === "dismiss") {
        setStripeActionMessage("");
        return;
      }

      if (result.type === "success") {
        const callbackStatus = getStripeConnectCallbackStatus(result.url);
        setStripeActionMessage(
          "Stripe onboarding returned to the app. Refreshing seller payout status..."
        );
        // Always refetch on return: the auth session consumes the redirect
        // URL, so the /stripe-connect-return deep-link route (and its own
        // refetch effect) usually never fires. Without this the dashboard
        // only refreshed on a later remount — sellers saw "not connected"
        // until they tapped Connect Stripe a second time.
        const refreshed = await refetchStripeConnectStatusUntilSettled(
          () => stripeStatusQuery.refetch(),
          callbackStatus === "refresh" ? { attempts: 1 } : undefined
        );
        if (refreshed.error) {
          throw refreshed.error;
        }
        if (callbackStatus === "refresh") {
          setStripeActionError(
            "Stripe onboarding still needs more information. Tap Connect Stripe to continue."
          );
          setStripeActionMessage("");
        } else if (refreshed.data?.chargesEnabled) {
          // Charges confirmed live: wake any already-mounted Terminal
          // provider so the SDK initializes off this connect.
          requestTerminalSdkInit();
          setStripeActionMessage(
            "Stripe onboarding returned to the app. Card-payment status is now refreshed."
          );
        } else {
          setStripeActionMessage(
            "Returned from Stripe. Stripe setup is still pending completion."
          );
        }
      }
    } catch (caughtError) {
      setStripeActionError(
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to launch Stripe onboarding."
      );
    } finally {
      setStripeActionLoading(false);
    }
  };

  // Standard Connect: link an EXISTING Stripe account via OAuth instead of
  // creating a new Express one. `app: true` makes the server-side OAuth
  // callback 302 back into this auth session instead of a web page.
  const handleStripeStandardConnect = async () => {
    setStripeActionLoading(true);
    setStripeActionError("");
    setStripeActionMessage("");

    try {
      const signedEvent = createSignedStripeConnectAuthEvent(session, {
        method: "POST",
        path: "/api/stripe/connect/standard/start",
      });
      const { url } = await mobileApiClient.startStripeStandardConnect({
        pubkey: session.pubkey,
        signedEvent,
        app: true,
      });
      // Ephemeral session: without it the sheet shares Safari cookies, so
      // Stripe's OAuth page silently pre-selects whatever account the seller
      // last signed into in Safari (e.g. the platform's own account on a
      // review device) instead of offering the sign-in form for ANY account.
      const result = await WebBrowser.openAuthSessionAsync(
        url,
        createStripeConnectRedirectBaseUrl(),
        { preferEphemeralSession: true }
      );

      if (result.type === "cancel" || result.type === "dismiss") {
        return;
      }

      if (result.type === "success") {
        const callbackStatus = getStripeConnectCallbackStatus(result.url);
        if (callbackStatus !== "success") {
          // Declined or errored at Stripe: the callback bounced back bare, so
          // nothing was linked — say so instead of implying progress.
          setStripeActionMessage(
            "Stripe connection was cancelled before it finished."
          );
          return;
        }
        setStripeActionMessage(
          "Returned from Stripe. Refreshing seller payout status..."
        );
        const refreshed = await refetchStripeConnectStatusUntilSettled(() =>
          stripeStatusQuery.refetch()
        );
        if (refreshed.error) {
          throw refreshed.error;
        }
        if (refreshed.data?.chargesEnabled) {
          // Charges confirmed live: wake any already-mounted Terminal
          // provider so the SDK initializes off this connect.
          requestTerminalSdkInit();
          setStripeActionMessage(
            "Your Stripe account is connected. Card payments are enabled."
          );
        } else {
          setStripeActionMessage(
            "Returned from Stripe. Stripe setup is still pending completion."
          );
        }
      }
    } catch (caughtError) {
      setStripeActionError(
        getErrorMessage(caughtError, "Failed to launch Stripe connection.")
      );
    } finally {
      setStripeActionLoading(false);
    }
  };

  const handleRefreshSquareStatus = async () => {
    setSquareActionError("");
    setSquareActionMessage("");

    try {
      const result = await squareStatusQuery.refetch();
      if (result.error) {
        throw result.error;
      }
    } catch (caughtError) {
      setSquareActionError(
        getErrorMessage(
          caughtError,
          "Square connection status could not be refreshed."
        )
      );
    }
  };

  // Square OAuth: link an existing Square account for ONLINE card checkout.
  // `app: true` makes the server mark the OAuth state so the redirect page
  // bounces back into this auth session instead of the web settings page.
  const handleSquareConnect = async () => {
    setSquareActionLoading(true);
    setSquareActionError("");
    setSquareActionMessage("");

    try {
      const signedEvent = createSignedSquareOAuthAuthEvent(session, {
        method: "POST",
        path: "/api/square/oauth/start",
      });
      const { authorizeUrl } = await mobileApiClient.startSquareOAuth({
        pubkey: session.pubkey,
        signedEvent,
        app: true,
      });
      const result = await WebBrowser.openAuthSessionAsync(
        authorizeUrl,
        createSquareConnectRedirectBaseUrl()
      );

      if (result.type === "cancel" || result.type === "dismiss") {
        // The sheet may have closed after the redirect page completed the
        // connection, so quietly re-read the status either way.
        const refreshed = await squareStatusQuery.refetch();
        if (refreshed.data?.connected) {
          setSquareActionMessage(
            "Your Square account is connected. Online card checkout is enabled."
          );
        }
        return;
      }

      if (result.type === "success") {
        const callback = getSquareConnectCallbackStatus(result.url);
        // Always refetch on return: the auth session consumes the redirect
        // URL, so the /square-connect-return deep-link route usually never
        // fires (same race as the Stripe flow).
        const refreshed = await squareStatusQuery.refetch();
        if (refreshed.error) {
          throw refreshed.error;
        }
        if (refreshed.data?.connected) {
          setSquareActionMessage(
            "Your Square account is connected. Online card checkout is enabled."
          );
        } else if (callback?.status === "error") {
          setSquareActionError(
            callback.errorMessage || "Square connection failed. Try again."
          );
        } else {
          setSquareActionMessage(
            "Square connection was cancelled before it finished."
          );
        }
      }
    } catch (caughtError) {
      setSquareActionError(
        getErrorMessage(caughtError, "Failed to launch Square connection.")
      );
    } finally {
      setSquareActionLoading(false);
    }
  };

  const handleSignOut = async () => {
    setSignOutError("");
    try {
      await clearPrivateSellerOrderQueries(queryClient);
      await clearSession();
      router.replace("/sign-in" as Href);
    } catch (caughtError) {
      setSignOutError(
        getErrorMessage(caughtError, "Could not sign out. Please try again.")
      );
    }
  };

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Your seller workspace"
        title="Vendor dashboard"
        description="Manage your storefront, listings, orders, and shipping from one place."
      />

      <SellerCard
        title="Vendor session"
        description="Your mobile seller workspace uses the same Self-sown identity model as the web app."
      >
        <View style={styles.rowBetween}>
          <View style={styles.metaBlock}>
            <Text style={styles.metaLabel}>Auth method</Text>
            <Text style={styles.metaValue}>{session.authMethod}</Text>
          </View>
          <View style={styles.metaBlock}>
            <Text style={styles.metaLabel}>Pubkey</Text>
            <Text style={styles.metaValueShort}>
              {session.pubkey.slice(0, 12)}...
            </Text>
          </View>
        </View>
        {session.email ? (
          <View style={styles.metaBlock}>
            <Text style={styles.metaLabel}>Email</Text>
            <Text style={styles.metaValue}>{session.email}</Text>
          </View>
        ) : null}
        <ActionButton
          label="Sign out"
          onPress={() => void handleSignOut()}
          variant="secondary"
        />
        {signOutError ? (
          <Text style={styles.errorText}>{signOutError}</Text>
        ) : null}
      </SellerCard>

      <NotificationSettings />

      <SellerCard
        title="Profile & settings"
        description="Edit your market profile, account preferences, and saved addresses."
      >
        <ActionButton
          label="Open settings"
          onPress={() => router.push("/settings" as Href)}
          variant="secondary"
        />
      </SellerCard>

      <SellerCard
        title={`Setup progress: ${completedCount}/${setupItems.length}`}
        description="Complete your storefront and payout setup."
      >
        {setupItems.map((item) => (
          <View key={item.label} style={styles.rowBetween}>
            <Text style={styles.checkLabel}>{item.label}</Text>
            <StatusPill
              tone={item.complete ? "success" : "warning"}
              label={item.complete ? "Done" : "Next"}
            />
          </View>
        ))}
      </SellerCard>

      <SellerCard
        title="Stall summary"
        description="Review your public storefront and manage your listings."
      >
        <View style={styles.metaBlock}>
          <Text style={styles.metaLabel}>Stall name</Text>
          <Text style={styles.metaValue}>
            {storefrontLoadErrorMessage
              ? "Unavailable right now"
              : shopProfile?.content.name || "Not saved yet"}
          </Text>
        </View>
        <View style={styles.metaBlock}>
          <Text style={styles.metaLabel}>Stall slug</Text>
          <Text style={styles.metaValue}>
            {storefrontLoadErrorMessage
              ? "Unavailable right now"
              : shopProfile?.content.storefront?.shopSlug ||
                "No public slug yet"}
          </Text>
        </View>
        <View style={styles.metaBlock}>
          <Text style={styles.metaLabel}>Vendor listings</Text>
          <Text style={styles.metaValue}>
            {listingsQuery.isLoading
              ? "Loading..."
              : listingsErrorMessage
                ? "Unavailable right now"
                : `${listingCount} cached listings`}
          </Text>
        </View>
        {storefrontLoadErrorMessage ? (
          <Text style={styles.errorText}>{storefrontLoadErrorMessage}</Text>
        ) : null}
        {listingsErrorMessage ? (
          <Text style={styles.errorText}>{listingsErrorMessage}</Text>
        ) : null}
        <ActionButton
          label="Edit storefront basics"
          onPress={() => router.push("/storefront" as Href)}
        />
        <ActionButton
          label="Review listings"
          onPress={() => router.push("/listings" as Href)}
          variant="secondary"
        />
        {storefrontLoadErrorMessage || listingsErrorMessage ? (
          <ActionButton
            label="Retry seller data"
            onPress={() => void handleRefreshSellerData()}
            variant="secondary"
            loading={
              profileQuery.isFetching ||
              notificationEmailQuery.isFetching ||
              listingsQuery.isFetching
            }
          />
        ) : null}
      </SellerCard>

      <SellerCard
        title="Stripe Connect"
        description="Check card-payment status and complete your payout setup."
      >
        <View style={styles.rowBetween}>
          <Text style={styles.checkLabel}>Current status</Text>
          <StatusPill
            tone={stripeStatusErrorMessage ? "warning" : stripeTone}
            label={
              stripeStatusErrorMessage ? "Status unavailable" : stripeLabel
            }
          />
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Charges enabled</Text>
          <Text style={styles.metaValue}>
            {stripeStatusErrorMessage
              ? "Unavailable"
              : stripeStatus?.chargesEnabled
                ? "Yes"
                : "No"}
          </Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Payouts enabled</Text>
          <Text style={styles.metaValue}>
            {stripeStatusErrorMessage
              ? "Unavailable"
              : stripeStatus?.payoutsEnabled
                ? "Yes"
                : "No"}
          </Text>
        </View>
        {stripeStatusErrorMessage ? (
          <Text style={styles.errorText}>{stripeStatusErrorMessage}</Text>
        ) : null}
        {stripeActionError ? (
          stripeActionError !== stripeStatusErrorMessage ? (
            <Text style={styles.errorText}>{stripeActionError}</Text>
          ) : null
        ) : null}
        {stripeActionMessage ? (
          <Text style={styles.successText}>{stripeActionMessage}</Text>
        ) : null}
        {!stripeStatus?.chargesEnabled &&
        !stripeStatusErrorMessage &&
        !squareConnected ? (
          <>
            <Pressable
              style={styles.rowBetween}
              onPress={() => setCountryPickerOpen(true)}
            >
              <Text style={styles.checkLabel}>Account country</Text>
              <Text style={styles.metaValue}>
                {STRIPE_CONNECT_COUNTRIES.find(
                  (country) => country.code === stripeCountry
                )?.name ?? stripeCountry}
              </Text>
            </Pressable>
            <Text style={styles.metaLabel}>
              This sets your Stripe account&apos;s country and can&apos;t be
              changed later.
            </Text>
            <Modal
              visible={countryPickerOpen}
              transparent
              animationType="fade"
              onRequestClose={() => setCountryPickerOpen(false)}
            >
              <Pressable
                style={styles.pickerBackdrop}
                onPress={() => setCountryPickerOpen(false)}
              >
                <View style={styles.pickerSheet}>
                  <FlatList
                    data={STRIPE_CONNECT_COUNTRIES}
                    keyExtractor={(item) => item.code}
                    renderItem={({ item }) => (
                      <Pressable
                        style={styles.pickerOption}
                        onPress={() => {
                          setStripeCountry(item.code);
                          setCountryPickerOpen(false);
                        }}
                      >
                        <Text style={styles.pickerOptionText}>{item.name}</Text>
                      </Pressable>
                    )}
                  />
                </View>
              </Pressable>
            </Modal>
            <Text style={styles.metaLabel}>
              A Stripe account also enables Tap to Pay checkout in this app.
            </Text>
          </>
        ) : null}
        {squareConnected && !stripeStatus?.hasAccount ? (
          <Text style={styles.metaLabel}>
            Square is connected for card checkout. To switch to Stripe,
            disconnect Square from payment settings on the web.
          </Text>
        ) : (
          <ActionButton
            label={
              stripeStatusErrorMessage
                ? "Retry Stripe status"
                : stripeStatus?.chargesEnabled
                  ? "Refresh Stripe status"
                  : "Connect Stripe"
            }
            onPress={() => {
              if (stripeStatusErrorMessage || stripeStatus?.chargesEnabled) {
                void handleRefreshStripeStatus();
              } else {
                void handleStripeConnect();
              }
            }}
            loading={stripeActionLoading || stripeStatusQuery.isFetching}
          />
        )}
        {!stripeStatus?.chargesEnabled &&
        !stripeStatusErrorMessage &&
        !squareConnected ? (
          <Pressable
            onPress={() => void handleStripeStandardConnect()}
            disabled={stripeActionLoading || stripeStatusQuery.isFetching}
          >
            <Text style={styles.standardConnectLink}>
              I already have a Stripe account
            </Text>
          </Pressable>
        ) : null}
      </SellerCard>

      {squareConfigured || squareConnected ? (
        <SellerCard
          title="Square"
          description="Connect a Square account to take card payments on your online storefront."
        >
          <View style={styles.rowBetween}>
            <Text style={styles.checkLabel}>Current status</Text>
            <StatusPill
              tone={
                squareStatusErrorMessage
                  ? "warning"
                  : squareConnected
                    ? "success"
                    : "neutral"
              }
              label={
                squareStatusErrorMessage
                  ? "Status unavailable"
                  : squareConnected
                    ? "Connected"
                    : "Not connected"
              }
            />
          </View>
          {squareConnected && squareStatus?.currency ? (
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Settlement currency</Text>
              <Text style={styles.metaValue}>{squareStatus.currency}</Text>
            </View>
          ) : null}
          {squareConnected && squareStatus?.environment === "sandbox" ? (
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>Environment</Text>
              <Text style={styles.metaValue}>Sandbox</Text>
            </View>
          ) : null}
          {squareConnected ? (
            <Text style={styles.metaLabel}>
              Square handles online card checkout. Tap to Pay in this app
              requires a Stripe account.
            </Text>
          ) : null}
          {squareStatusErrorMessage ? (
            <Text style={styles.errorText}>{squareStatusErrorMessage}</Text>
          ) : null}
          {squareActionError ? (
            squareActionError !== squareStatusErrorMessage ? (
              <Text style={styles.errorText}>{squareActionError}</Text>
            ) : null
          ) : null}
          {squareActionMessage ? (
            <Text style={styles.successText}>{squareActionMessage}</Text>
          ) : null}
          {stripeStatus?.hasAccount && !squareConnected ? (
            <Text style={styles.metaLabel}>
              Stripe is connected. To use Square instead, disconnect Stripe from
              payment settings on the web.
            </Text>
          ) : (
            <ActionButton
              label={
                squareStatusErrorMessage
                  ? "Retry Square status"
                  : squareConnected
                    ? "Refresh Square status"
                    : "Connect Square"
              }
              onPress={() => {
                if (squareStatusErrorMessage || squareConnected) {
                  void handleRefreshSquareStatus();
                } else {
                  void handleSquareConnect();
                }
              }}
              loading={squareActionLoading || squareStatusQuery.isFetching}
            />
          )}
        </SellerCard>
      ) : null}
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  metaBlock: {
    gap: 4,
  },
  metaLabel: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.7,
  },
  metaValue: {
    color: sellerThemeTokens.text,
    fontSize: 16,
    fontWeight: "600",
  },
  metaValueShort: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontWeight: "600",
  },
  checkLabel: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    flex: 1,
    lineHeight: 22,
  },
  errorText: {
    color: sellerThemeTokens.danger,
    fontSize: 14,
    lineHeight: 20,
  },
  successText: {
    color: sellerThemeTokens.success,
    fontSize: 14,
    lineHeight: 20,
  },
  pickerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    padding: 24,
  },
  pickerSheet: {
    backgroundColor: "#ffffff",
    borderRadius: 6,
    maxHeight: "70%",
    overflow: "hidden",
  },
  pickerOption: {
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  pickerOptionText: {
    color: sellerThemeTokens.text,
    fontSize: 16,
    fontWeight: "600",
  },
  standardConnectLink: {
    color: sellerThemeTokens.mutedText,
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
    textDecorationLine: "underline",
  },
});
