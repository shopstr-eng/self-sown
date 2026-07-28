import { useContext, useEffect, useState } from "react";
import { useRouter } from "next/router";
import {
  Button,
  Input,
  Select,
  SelectItem,
  Switch,
  useDisclosure,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@heroui/react";
import {
  CreditCardIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ReceiptPercentIcon,
  PlusIcon,
  TrashIcon,
  LinkSlashIcon,
  BuildingStorefrontIcon,
  ArrowDownTrayIcon,
} from "@heroicons/react/24/outline";
import {
  BLUEBUTTONCLASSNAMES,
  WHITEBUTTONCLASSNAMES,
  DANGERBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";
import ProtectedRoute from "@/components/utility-components/protected-route";
import { SettingsBreadCrumbs } from "@/components/settings/settings-bread-crumbs";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import {
  buildMcpRequestProofTemplate,
  buildStripeAccountStatusProof,
  buildStripeManageLinkProof,
  buildStripeStandardStartProof,
  buildStripeTaxSettingsProof,
  buildStripeDisconnectProof,
} from "@/utils/mcp/request-proof";
import StripeConnectModal from "@/components/stripe-connect/StripeConnectModal";
import MilkMarketSpinner from "@/components/utility-components/mm-spinner";
import {
  STRIPE_CONNECT_COUNTRIES,
  COUNTRIES_WITH_REGIONAL_TAX,
  isValidTaxRegion,
} from "@/utils/stripe/connect-countries";
import {
  fetchSquareConnectionStatus,
  startSquareOAuth,
  disconnectSquare,
  type SquareConnectionStatus,
} from "@/utils/square/client-api";

interface AccountStatus {
  hasAccount: boolean;
  accountId?: string;
  onboardingComplete: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  accountType?: "express" | "standard" | null;
}

interface TaxRegistration {
  id: string;
  state: string | null;
  country: string;
  status: string;
  activeFrom: number | null;
  expiresAt: number | null;
}

interface TaxStatus {
  taxEnabled: boolean;
  settingsStatus: string | null;
  settingsStatusDetail: string | null;
  registrations: TaxRegistration[];
}

type TaxAction =
  | "status"
  | "enable"
  | "disable"
  | "add_registration"
  | "remove_registration";

const PaymentsSettingsPage = () => {
  const router = useRouter();
  const { pubkey, signer } = useContext(SignerContext);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const {
    isOpen: isDisconnectOpen,
    onOpen: onDisconnectOpen,
    onClose: onDisconnectClose,
  } = useDisclosure();
  const {
    isOpen: isSquareDisconnectOpen,
    onOpen: onSquareDisconnectOpen,
    onClose: onSquareDisconnectClose,
  } = useDisclosure();

  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<
    "dashboard" | "update" | "disconnect" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [squareStatus, setSquareStatus] =
    useState<SquareConnectionStatus | null>(null);
  const [squareLoading, setSquareLoading] = useState(true);
  const [squareAction, setSquareAction] = useState<
    "connect" | "disconnect" | null
  >(null);

  const [taxStatus, setTaxStatus] = useState<TaxStatus | null>(null);
  const [taxLoading, setTaxLoading] = useState(false);
  const [taxBusy, setTaxBusy] = useState<string | null>(null);
  const [newState, setNewState] = useState("");
  const [newTaxCountry, setNewTaxCountry] = useState("US");
  const [standardAction, setStandardAction] = useState(false);
  const [taxError, setTaxError] = useState<string | null>(null);
  const [taxInfo, setTaxInfo] = useState<string | null>(null);

  const loadStatus = async (): Promise<AccountStatus | null> => {
    if (!pubkey || !signer?.sign) return null;
    setLoading(true);
    setError(null);
    try {
      const signedEvent = await signer.sign(
        buildMcpRequestProofTemplate(buildStripeAccountStatusProof(pubkey))
      );
      const res = await fetch("/api/stripe/connect/account-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey, signedEvent }),
      });
      if (!res.ok) {
        throw new Error("Failed to load Stripe account status");
      }
      const data = (await res.json()) as AccountStatus;
      setStatus(data);
      return data;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load Stripe account status"
      );
      return null;
    } finally {
      setLoading(false);
    }
  };

  const loadSquareStatus = async () => {
    if (!pubkey || !signer?.sign) return;
    setSquareLoading(true);
    try {
      const data = await fetchSquareConnectionStatus(signer as never, pubkey);
      setSquareStatus(data);
    } catch {
      // Treat a failure as "not connected" so the page still renders; the
      // seller can retry. Square stays fail-closed when unconfigured.
      setSquareStatus({ configured: false, connected: false });
    } finally {
      setSquareLoading(false);
    }
  };

  // Refresh Stripe account status and, when the seller can take cards, sales tax
  // — always in this order. Both sign a Nostr proof and the passphrase challenge
  // is single-flight, so they must never run concurrently. Tax eligibility is
  // read from loadStatus's return value (not a separate status-watching effect)
  // so the tax sign can't fire concurrently with anything else.
  const refreshStripeStatus = async () => {
    const accountStatus = await loadStatus();
    if (accountStatus?.hasAccount && accountStatus.chargesEnabled) {
      await loadTaxStatus();
    }
  };

  // On first load, run every signed call in one ordered sequence: Stripe (+ tax)
  // then Square. The passphrase challenge is single-flight — firing signs
  // concurrently lets a later challenge replace an earlier one's resolver,
  // leaving a sign hung forever (stuck spinner until the page is remounted,
  // which is why clicking away and back "fixes" it). In order, the first sign
  // decrypts and caches the key, so every later sign reuses it with no extra
  // prompt.
  useEffect(() => {
    if (!pubkey || !signer?.sign) return;
    let cancelled = false;
    (async () => {
      await refreshStripeStatus();
      if (cancelled) return;
      await loadSquareStatus();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, signer]);

  // Begin the Square OAuth flow: sign the proof, get the authorize URL, and
  // send the browser to Square. The bidirectional XOR is enforced server-side.
  const handleConnectSquare = async () => {
    if (!pubkey || !signer?.sign) return;
    setSquareAction("connect");
    setError(null);
    setInfo(null);
    try {
      const authorizeUrl = await startSquareOAuth(signer as never, pubkey);
      window.location.href = authorizeUrl;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to start Square connection"
      );
      setSquareAction(null);
    }
  };

  const handleDisconnectSquare = async () => {
    if (!pubkey || !signer?.sign) return;
    setSquareAction("disconnect");
    setError(null);
    setInfo(null);
    try {
      await disconnectSquare(signer as never, pubkey);
      onSquareDisconnectClose();
      setInfo(
        "Square disconnected. You can connect Square again or set up Stripe."
      );
      await loadSquareStatus();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to disconnect Square account"
      );
    } finally {
      setSquareAction(null);
    }
  };

  useEffect(() => {
    if (router.query.stripe === "updated") {
      setInfo("Stripe details updated. Status refreshed.");
    } else if (router.query.stripe === "refresh") {
      setInfo("Stripe link expired. Please try again.");
    } else if (router.query.stripe === "standard-success") {
      setInfo("Your Stripe account is connected.");
    } else if (router.query.stripe === "standard-declined") {
      setError("Stripe connection was cancelled before it finished.");
    } else if (router.query.stripe === "standard-error") {
      setError("Stripe connection failed. Please try again.");
    }
  }, [router.query.stripe]);

  // Standard Connect (OAuth): link the seller's OWN full Stripe account. The
  // callback replaces any existing linkage, so this is also the Express ->
  // Standard migration path.
  const handleConnectStandard = async () => {
    if (!pubkey || !signer?.sign) return;
    setStandardAction(true);
    setError(null);
    setInfo(null);
    try {
      const signedEvent = await signer.sign(
        buildMcpRequestProofTemplate(buildStripeStandardStartProof(pubkey))
      );
      const res = await fetch("/api/stripe/connect/standard/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey, signedEvent }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Failed to start Stripe connection");
      }
      window.open(data.url, "_blank", "noopener");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to start Stripe connection"
      );
    } finally {
      setStandardAction(false);
    }
  };

  const openManageLink = async (mode: "dashboard" | "update") => {
    if (!pubkey || !signer?.sign || !status?.accountId) return;
    setActionLoading(mode);
    setError(null);
    try {
      const signedEvent = await signer.sign(
        buildMcpRequestProofTemplate(
          buildStripeManageLinkProof({
            pubkey,
            accountId: status.accountId,
            mode,
          })
        )
      );
      const res = await fetch("/api/stripe/connect/manage-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pubkey,
          accountId: status.accountId,
          mode,
          signedEvent,
          returnPath: "/settings/payments?stripe=updated",
          refreshPath: "/settings/payments?stripe=refresh",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data?.fallback === "update" && mode === "dashboard") {
          setError(
            data.error ||
              "Stripe dashboard isn't available yet. Please finish onboarding first."
          );
        } else {
          throw new Error(data?.error || "Failed to open Stripe");
        }
        return;
      }
      window.open(data.url, "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open Stripe");
    } finally {
      setActionLoading(null);
    }
  };

  // Unlink the seller's Stripe account from Milk Market so they can connect a
  // different one. Leaves the account untouched at Stripe; only removes our link.
  const handleDisconnect = async () => {
    if (!pubkey || !signer?.sign) return;
    setActionLoading("disconnect");
    setError(null);
    setInfo(null);
    try {
      const signedEvent = await signer.sign(
        buildMcpRequestProofTemplate(buildStripeDisconnectProof(pubkey))
      );
      const res = await fetch("/api/stripe/connect/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey, signedEvent }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Failed to disconnect Stripe account");
      }
      onDisconnectClose();
      setTaxStatus(null);
      setInfo(
        "Stripe account disconnected. You can connect a different account below."
      );
      await loadStatus();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to disconnect Stripe account"
      );
    } finally {
      setActionLoading(null);
    }
  };

  // Shared POST to the tax-settings endpoint. Every action returns the latest
  // combined status, so we always refresh local state from the response.
  const postTaxSettings = async (
    action: TaxAction,
    extra?: {
      state?: string;
      country?: string;
      region?: string;
      registrationId?: string;
    }
  ) => {
    if (!pubkey || !signer?.sign) return;
    const signedEvent = await signer.sign(
      buildMcpRequestProofTemplate(buildStripeTaxSettingsProof(pubkey))
    );
    const res = await fetch("/api/stripe/connect/tax-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey, action, signedEvent, ...extra }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || "Failed to update sales tax settings");
    }
    setTaxStatus({
      taxEnabled: !!data.taxEnabled,
      settingsStatus: data.settingsStatus ?? null,
      settingsStatusDetail: data.settingsStatusDetail ?? null,
      registrations: Array.isArray(data.registrations)
        ? data.registrations
        : [],
    });
  };

  const loadTaxStatus = async () => {
    if (!pubkey || !signer?.sign) return;
    setTaxLoading(true);
    setTaxError(null);
    try {
      await postTaxSettings("status");
    } catch (e) {
      setTaxError(
        e instanceof Error ? e.message : "Failed to load sales tax settings"
      );
    } finally {
      setTaxLoading(false);
    }
  };

  const handleToggleTax = async (enabled: boolean) => {
    setTaxBusy("toggle");
    setTaxError(null);
    setTaxInfo(null);
    try {
      await postTaxSettings(enabled ? "enable" : "disable");
      setTaxInfo(
        enabled
          ? "Sales tax collection turned on."
          : "Sales tax collection turned off."
      );
    } catch (e) {
      setTaxError(
        e instanceof Error ? e.message : "Failed to update sales tax setting"
      );
    } finally {
      setTaxBusy(null);
    }
  };

  const handleAddRegistration = async () => {
    const country = newTaxCountry;
    const needsRegion = COUNTRIES_WITH_REGIONAL_TAX.has(country);
    const region = newState.trim().toUpperCase();
    if (needsRegion && !isValidTaxRegion(country, region)) {
      setTaxError(
        country === "US"
          ? "Enter a valid 2-letter US state code (e.g. CA)."
          : "Enter a valid 2-letter Canadian province code (e.g. ON)."
      );
      return;
    }
    setTaxBusy("add");
    setTaxError(null);
    setTaxInfo(null);
    try {
      await postTaxSettings("add_registration", {
        country,
        ...(needsRegion ? { region } : {}),
      });
      setNewState("");
      setTaxInfo(
        `Registered to collect tax in ${needsRegion ? region : country}.`
      );
    } catch (e) {
      setTaxError(
        e instanceof Error ? e.message : "Failed to add registration"
      );
    } finally {
      setTaxBusy(null);
    }
  };

  const handleRemoveRegistration = async (registrationId: string) => {
    setTaxBusy(registrationId);
    setTaxError(null);
    setTaxInfo(null);
    try {
      await postTaxSettings("remove_registration", { registrationId });
      setTaxInfo("State registration removed.");
    } catch (e) {
      setTaxError(
        e instanceof Error ? e.message : "Failed to remove state registration"
      );
    } finally {
      setTaxBusy(null);
    }
  };

  return (
    <ProtectedRoute>
      <div className="flex min-h-screen flex-col bg-white pt-24 pb-20">
        <div className="mx-auto w-full max-w-3xl px-4">
          <SettingsBreadCrumbs />
          <div className="mb-6 flex items-center gap-3">
            <CreditCardIcon className="text-primary-blue h-8 w-8" />
            <h1 className="text-3xl font-bold text-black">Payments</h1>
          </div>
          <p className="mb-6 text-sm text-gray-700">
            Accept credit card payments with one card processor of your choice —
            either <span className="font-semibold">Stripe</span> or{" "}
            <span className="font-semibold">Square</span>. You connect your own
            account, payouts go straight to your bank, and you can switch
            processors at any time (connect one, and the other is turned off).
          </p>

          {loading || squareLoading ? (
            <MilkMarketSpinner />
          ) : (
            <div className="shadow-neo space-y-4 rounded-md border-2 border-black bg-white p-5">
              {squareStatus?.connected ? (
                <div className="space-y-5">
                  <div className="flex items-start gap-3">
                    <BuildingStorefrontIcon className="text-primary-blue mt-0.5 h-6 w-6 flex-shrink-0" />
                    <div>
                      <p className="font-bold text-black">Square connected</p>
                      <p className="text-sm text-gray-700">
                        Card payments at checkout are processed by your Square
                        account. Charges and payouts are handled by Square.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <StatusPill label="Card payments" ok={true} />
                    <StatusPill
                      label={`Currency: ${squareStatus.currency || "—"}`}
                      ok={!!squareStatus.currency}
                    />
                    <StatusPill
                      label={`Location: ${
                        squareStatus.locationId ? "set" : "missing"
                      }`}
                      ok={!!squareStatus.locationId}
                    />
                  </div>

                  {!squareStatus.locationId && (
                    <div className="rounded-md border-2 border-yellow-500 bg-yellow-50 p-3 text-sm text-black">
                      We couldn&apos;t read a Square business location. Card
                      checkout stays off until a location is available.
                      Reconnect Square to refresh it.
                    </div>
                  )}

                  {squareStatus.environment === "sandbox" && (
                    <div className="rounded-md border-2 border-black bg-gray-50 p-3 text-xs text-black">
                      Square is running in <strong>sandbox</strong> mode. Real
                      cards won&apos;t be charged.
                    </div>
                  )}

                  <div className="space-y-2 border-t-2 border-black pt-4">
                    <p className="font-bold text-black">
                      Import your Square catalog
                    </p>
                    <p className="text-sm text-gray-700">
                      Turn your Square items into marketplace listings. You
                      choose what to publish.
                    </p>
                    <Button
                      className={`${BLUEBUTTONCLASSNAMES} mt-1`}
                      startContent={<ArrowDownTrayIcon className="h-4 w-4" />}
                      onClick={() =>
                        router.push("/settings/stall?import=square")
                      }
                    >
                      Import from Square
                    </Button>
                  </div>

                  <div className="space-y-2 border-t-2 border-black pt-4">
                    <p className="font-bold text-black">Disconnect Square</p>
                    <p className="text-sm text-gray-700">
                      Remove this Square account from Milk Market, for example
                      to switch to Stripe or a different Square account. Card
                      payments will stop until you connect a processor again.
                      Your Square account itself isn&apos;t deleted.
                    </p>
                    <Button
                      className={`${DANGERBUTTONCLASSNAMES} mt-1`}
                      startContent={<LinkSlashIcon className="h-4 w-4" />}
                      isLoading={squareAction === "disconnect"}
                      onClick={onSquareDisconnectOpen}
                    >
                      Disconnect Square
                    </Button>
                  </div>

                  {squareStatus.merchantId && (
                    <p className="text-xs text-gray-500">
                      Merchant ID:{" "}
                      <span className="font-mono">
                        {squareStatus.merchantId}
                      </span>
                    </p>
                  )}
                </div>
              ) : !status?.hasAccount ? (
                <div className="space-y-5">
                  <div className="flex items-start gap-3">
                    <ExclamationTriangleIcon className="mt-0.5 h-6 w-6 flex-shrink-0 text-yellow-600" />
                    <div>
                      <p className="font-bold text-black">
                        No card processor connected
                      </p>
                      <p className="text-sm text-gray-700">
                        Choose one processor to accept credit cards. You can
                        change it later.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-3 rounded-md border-2 border-black bg-white p-4">
                      <div className="flex items-center gap-2">
                        <CreditCardIcon className="text-primary-blue h-6 w-6" />
                        <p className="font-bold text-black">Stripe</p>
                      </div>
                      <p className="text-sm text-gray-700">
                        Card payments, payouts to your bank, and optional sales
                        tax / VAT collection. Two ways to get started:
                      </p>

                      <div className="flex flex-col gap-2 rounded-md border-2 border-black bg-gray-50 p-3">
                        <p className="text-sm font-bold text-black">
                          New to Stripe — quick setup
                        </p>
                        <p className="text-xs text-gray-600">
                          We create a Stripe account for you in a few minutes.
                          You manage payouts from a simplified dashboard without
                          leaving Milk Market.
                        </p>
                        <Button
                          className={BLUEBUTTONCLASSNAMES}
                          startContent={
                            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                          }
                          onClick={onOpen}
                        >
                          Set Up Stripe
                        </Button>
                      </div>

                      <div className="flex flex-col gap-2 rounded-md border-2 border-black bg-gray-50 p-3">
                        <p className="text-sm font-bold text-black">
                          Have a Stripe account — connect it
                        </p>
                        <p className="text-xs text-gray-600">
                          Link your existing Stripe account and keep the full
                          Stripe dashboard. You can also create a full Stripe
                          account during this setup.
                        </p>
                        <Button
                          className={WHITEBUTTONCLASSNAMES}
                          startContent={
                            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                          }
                          isLoading={standardAction}
                          onClick={handleConnectStandard}
                        >
                          Connect Your Stripe Account
                        </Button>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2 rounded-md border-2 border-black bg-white p-4">
                      <div className="flex items-center gap-2">
                        <BuildingStorefrontIcon className="text-primary-blue h-6 w-6" />
                        <p className="font-bold text-black">Square</p>
                      </div>
                      <p className="flex-1 text-sm text-gray-700">
                        Card payments on your own Square account, plus one-click
                        import of your Square catalog into listings.
                      </p>
                      {squareStatus?.configured === false ? (
                        <p className="text-xs text-gray-500">
                          Square isn&apos;t available yet. Check back soon.
                        </p>
                      ) : (
                        <Button
                          className={WHITEBUTTONCLASSNAMES}
                          startContent={
                            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                          }
                          isLoading={squareAction === "connect"}
                          onClick={handleConnectSquare}
                        >
                          Connect Square
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <StatusPill
                      label="Onboarding"
                      ok={status.onboardingComplete}
                    />
                    <StatusPill
                      label="Card payments"
                      ok={status.chargesEnabled}
                    />
                    <StatusPill label="Payouts" ok={status.payoutsEnabled} />
                  </div>

                  {status.accountType === "express" && (
                    <div className="space-y-2 rounded-md border-2 border-black bg-blue-50 p-3 text-sm text-black">
                      <p className="font-bold">
                        Want the full Stripe experience?
                      </p>
                      <p>
                        You&apos;re connected with Stripe Express, which offers
                        a simplified dashboard. Switch to Standard Connect to
                        link your own Stripe account — full Stripe dashboard,
                        detailed reporting, and granular control. Your current
                        account keeps working until you finish switching.
                      </p>
                      <Button
                        className={WHITEBUTTONCLASSNAMES}
                        startContent={
                          <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                        }
                        isLoading={standardAction}
                        onClick={handleConnectStandard}
                      >
                        Switch to Standard Connect
                      </Button>
                    </div>
                  )}

                  {!status.onboardingComplete && (
                    <div className="rounded-md border-2 border-yellow-500 bg-yellow-50 p-3 text-sm text-black">
                      {status.accountType === "standard"
                        ? "Your Stripe account setup isn't finished yet. Complete the remaining steps in your Stripe dashboard."
                        : "Your Stripe onboarding isn't finished yet. Use \"Finish Stripe Setup\" below to complete the remaining steps. Once onboarding is complete, you'll be able to open the full Stripe Express dashboard."}
                    </div>
                  )}

                  <div className="space-y-3">
                    {status.accountType === "standard" ? (
                      <div>
                        <p className="font-bold text-black">
                          Your Stripe Dashboard
                        </p>
                        <p className="text-sm text-gray-700">
                          You connected your own Stripe account. Manage
                          payments, payouts, reports, and settings in the full
                          Stripe dashboard.
                        </p>
                        <Button
                          className={`${BLUEBUTTONCLASSNAMES} mt-2`}
                          startContent={
                            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                          }
                          onClick={() =>
                            window.open(
                              "https://dashboard.stripe.com",
                              "_blank",
                              "noopener"
                            )
                          }
                        >
                          Open Stripe Dashboard
                        </Button>
                      </div>
                    ) : status.onboardingComplete ? (
                      <div>
                        <p className="font-bold text-black">
                          Stripe Express Dashboard
                        </p>
                        <p className="text-sm text-gray-700">
                          Manage payouts, connected bank accounts, accepted
                          payment methods, business profile, tax forms, and view
                          your transaction history on Stripe.
                        </p>
                        <Button
                          className={`${BLUEBUTTONCLASSNAMES} mt-2`}
                          startContent={
                            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                          }
                          isLoading={actionLoading === "dashboard"}
                          isDisabled={!status.chargesEnabled}
                          onClick={() => openManageLink("dashboard")}
                        >
                          Open Stripe Dashboard
                        </Button>
                      </div>
                    ) : (
                      <div>
                        <p className="font-bold text-black">
                          Finish Stripe Setup
                        </p>
                        <p className="text-sm text-gray-700">
                          Finish setting up your Stripe account to start
                          accepting card payments. You can complete verification
                          details, business owners, address, and any other
                          information Stripe still needs.
                        </p>
                        <Button
                          className={`${BLUEBUTTONCLASSNAMES} mt-2`}
                          startContent={
                            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                          }
                          isLoading={actionLoading === "update"}
                          onClick={() => openManageLink("update")}
                        >
                          Finish Stripe Setup
                        </Button>
                      </div>
                    )}
                  </div>

                  {status.chargesEnabled && (
                    <div className="space-y-3 border-t-2 border-black pt-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-2">
                          <ReceiptPercentIcon className="text-primary-blue mt-0.5 h-6 w-6 flex-shrink-0" />
                          <div>
                            <p className="font-bold text-black">Sales Tax</p>
                            <p className="text-sm text-gray-700">
                              Automatically calculate and collect sales tax (or
                              VAT) at checkout, based on your buyer&apos;s
                              shipping address. Only applies to single-seller
                              card (Stripe) checkouts.
                            </p>
                          </div>
                        </div>
                        <Switch
                          size="lg"
                          isSelected={!!taxStatus?.taxEnabled}
                          isDisabled={taxBusy !== null || taxLoading}
                          onValueChange={handleToggleTax}
                          classNames={{
                            wrapper:
                              "bg-gray-300 group-data-[selected=true]:bg-primary-yellow",
                            thumb:
                              "bg-white border-2 border-black group-data-[selected=true]:border-black shadow-neo",
                          }}
                        />
                      </div>

                      {taxLoading ? (
                        <MilkMarketSpinner />
                      ) : (
                        taxStatus?.taxEnabled && (
                          <div className="space-y-3">
                            <div className="rounded-md border-2 border-yellow-500 bg-yellow-50 p-3 text-xs text-black">
                              Only collect tax in jurisdictions where
                              you&apos;re registered with the tax authority. You
                              are responsible for filing and remitting the tax
                              you collect. Add each jurisdiction where
                              you&apos;re registered below.
                            </div>

                            <div>
                              <p className="mb-2 text-sm font-bold text-black">
                                Registered jurisdictions
                              </p>
                              {taxStatus.registrations.length === 0 ? (
                                <p className="text-sm text-gray-600">
                                  No jurisdictions added yet. Tax won&apos;t be
                                  charged until you add at least one.
                                </p>
                              ) : (
                                <ul className="space-y-2">
                                  {taxStatus.registrations.map((reg) => (
                                    <li
                                      key={reg.id}
                                      className="flex items-center justify-between rounded-md border-2 border-black bg-white px-3 py-2"
                                    >
                                      <span className="text-sm font-bold text-black">
                                        {reg.state || reg.country}
                                      </span>
                                      <Button
                                        size="sm"
                                        className={WHITEBUTTONCLASSNAMES}
                                        startContent={
                                          <TrashIcon className="h-4 w-4" />
                                        }
                                        isLoading={taxBusy === reg.id}
                                        onClick={() =>
                                          handleRemoveRegistration(reg.id)
                                        }
                                      >
                                        Remove
                                      </Button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>

                            <div className="flex flex-wrap items-end gap-2">
                              <Select
                                label="Country"
                                selectedKeys={[newTaxCountry]}
                                onChange={(e) =>
                                  setNewTaxCountry(e.target.value || "US")
                                }
                                className="max-w-[220px]"
                                classNames={{
                                  trigger: "border-2 border-black rounded-md",
                                }}
                              >
                                {STRIPE_CONNECT_COUNTRIES.map((c) => (
                                  <SelectItem key={c.code}>{c.name}</SelectItem>
                                ))}
                              </Select>
                              {COUNTRIES_WITH_REGIONAL_TAX.has(
                                newTaxCountry
                              ) && (
                                <Input
                                  label={
                                    newTaxCountry === "US"
                                      ? "State"
                                      : "Province"
                                  }
                                  placeholder={
                                    newTaxCountry === "US"
                                      ? "e.g. CA"
                                      : "e.g. ON"
                                  }
                                  value={newState}
                                  onValueChange={(v) =>
                                    setNewState(v.toUpperCase().slice(0, 2))
                                  }
                                  className="max-w-[140px]"
                                  classNames={{
                                    inputWrapper:
                                      "border-2 border-black rounded-md",
                                  }}
                                />
                              )}
                              <Button
                                className={BLUEBUTTONCLASSNAMES}
                                startContent={<PlusIcon className="h-4 w-4" />}
                                isLoading={taxBusy === "add"}
                                onClick={handleAddRegistration}
                              >
                                Add
                              </Button>
                            </div>

                            {taxStatus.registrations.length > 0 &&
                              taxStatus.settingsStatus &&
                              taxStatus.settingsStatus !== "active" && (
                                <div className="rounded-md border-2 border-yellow-500 bg-yellow-50 p-3 text-xs text-black">
                                  Stripe Tax status: {taxStatus.settingsStatus}
                                  {taxStatus.settingsStatusDetail
                                    ? ` (${taxStatus.settingsStatusDetail})`
                                    : ""}
                                  . Tax may not calculate until this is resolved
                                  in your Stripe dashboard.
                                </div>
                              )}
                          </div>
                        )
                      )}

                      {taxInfo && (
                        <p className="text-sm font-medium text-green-700">
                          {taxInfo}
                        </p>
                      )}
                      {taxError && (
                        <p className="text-sm font-medium text-red-600">
                          {taxError}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="space-y-2 border-t-2 border-black pt-4">
                    <p className="font-bold text-black">Disconnect Stripe</p>
                    <p className="text-sm text-gray-700">
                      Remove this Stripe account from Milk Market, for example
                      if you need to switch to a different account or fix a
                      broken connection. Card payments will stop until you
                      connect an account again. Your Stripe account itself
                      isn&apos;t deleted; you can still manage or close it from
                      Stripe.
                    </p>
                    <Button
                      className={`${DANGERBUTTONCLASSNAMES} mt-1`}
                      startContent={<LinkSlashIcon className="h-4 w-4" />}
                      isLoading={actionLoading === "disconnect"}
                      onClick={onDisconnectOpen}
                    >
                      Disconnect Stripe
                    </Button>
                  </div>

                  <p className="text-xs text-gray-500">
                    Account ID:{" "}
                    <span className="font-mono">{status.accountId}</span>
                  </p>
                </div>
              )}

              {info && (
                <p className="text-sm font-medium text-green-700">{info}</p>
              )}
              {error && (
                <p className="text-sm font-medium text-red-600">{error}</p>
              )}
            </div>
          )}

          {pubkey && (
            <StripeConnectModal
              isOpen={isOpen}
              onClose={() => {
                onClose();
                refreshStripeStatus();
              }}
              pubkey={pubkey}
              returnPath="/settings/payments?stripe=updated"
              refreshPath="/settings/payments?stripe=refresh"
            />
          )}

          <Modal
            backdrop="blur"
            isOpen={isDisconnectOpen}
            onClose={onDisconnectClose}
            classNames={{
              wrapper: "shadow-neo",
              base: "border-2 border-black rounded-md",
              backdrop: "bg-black/20 backdrop-blur-sm",
              header:
                "border-b-2 border-black bg-white rounded-t-md text-black",
              body: "py-6 bg-white",
              footer: "border-t-2 border-black bg-white rounded-b-md",
              closeButton:
                "hover:bg-gray-200 active:bg-gray-300 rounded-md text-black",
            }}
            isDismissable={actionLoading !== "disconnect"}
            placement="center"
            size="lg"
          >
            <ModalContent>
              <ModalHeader className="flex items-center gap-2 text-black">
                <ExclamationTriangleIcon className="h-6 w-6 text-red-500" />
                <span>Disconnect Stripe?</span>
              </ModalHeader>
              <ModalBody className="text-black">
                <p className="text-sm">
                  This removes your Stripe account from Milk Market. You
                  won&apos;t be able to accept card payments until you connect
                  an account again, and you&apos;ll need to re-enter any sales
                  tax settings on the new account.
                </p>
                <p className="text-sm">
                  Your Stripe account itself isn&apos;t deleted; any balance or
                  payouts stay with Stripe, where you can still manage or close
                  the account.
                </p>
              </ModalBody>
              <ModalFooter className="flex gap-2">
                <Button
                  className={WHITEBUTTONCLASSNAMES}
                  onClick={onDisconnectClose}
                  isDisabled={actionLoading === "disconnect"}
                >
                  Cancel
                </Button>
                <Button
                  className={DANGERBUTTONCLASSNAMES}
                  onClick={handleDisconnect}
                  isLoading={actionLoading === "disconnect"}
                  startContent={
                    actionLoading !== "disconnect" ? (
                      <LinkSlashIcon className="h-4 w-4" />
                    ) : undefined
                  }
                >
                  Disconnect
                </Button>
              </ModalFooter>
            </ModalContent>
          </Modal>

          <Modal
            backdrop="blur"
            isOpen={isSquareDisconnectOpen}
            onClose={onSquareDisconnectClose}
            classNames={{
              wrapper: "shadow-neo",
              base: "border-2 border-black rounded-md",
              backdrop: "bg-black/20 backdrop-blur-sm",
              header:
                "border-b-2 border-black bg-white rounded-t-md text-black",
              body: "py-6 bg-white",
              footer: "border-t-2 border-black bg-white rounded-b-md",
              closeButton:
                "hover:bg-gray-200 active:bg-gray-300 rounded-md text-black",
            }}
            isDismissable={squareAction !== "disconnect"}
            placement="center"
            size="lg"
          >
            <ModalContent>
              <ModalHeader className="flex items-center gap-2 text-black">
                <ExclamationTriangleIcon className="h-6 w-6 text-red-500" />
                <span>Disconnect Square?</span>
              </ModalHeader>
              <ModalBody className="text-black">
                <p className="text-sm">
                  This removes your Square account from Milk Market. You
                  won&apos;t be able to accept card payments until you connect a
                  processor again.
                </p>
                <p className="text-sm">
                  Your Square account itself isn&apos;t deleted; any balance or
                  payouts stay with Square, where you can still manage or close
                  the account.
                </p>
              </ModalBody>
              <ModalFooter className="flex gap-2">
                <Button
                  className={WHITEBUTTONCLASSNAMES}
                  onClick={onSquareDisconnectClose}
                  isDisabled={squareAction === "disconnect"}
                >
                  Cancel
                </Button>
                <Button
                  className={DANGERBUTTONCLASSNAMES}
                  onClick={handleDisconnectSquare}
                  isLoading={squareAction === "disconnect"}
                  startContent={
                    squareAction !== "disconnect" ? (
                      <LinkSlashIcon className="h-4 w-4" />
                    ) : undefined
                  }
                >
                  Disconnect
                </Button>
              </ModalFooter>
            </ModalContent>
          </Modal>
        </div>
      </div>
    </ProtectedRoute>
  );
};

const StatusPill = ({ label, ok }: { label: string; ok: boolean }) => (
  <div
    className={`flex items-center gap-2 rounded-md border-2 border-black p-2 text-sm font-bold ${
      ok ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-700"
    }`}
  >
    {ok ? (
      <CheckCircleIcon className="h-5 w-5 text-green-700" />
    ) : (
      <ExclamationTriangleIcon className="h-5 w-5 text-gray-500" />
    )}
    <span>
      {label}: {ok ? "Active" : "Pending"}
    </span>
  </div>
);

export default PaymentsSettingsPage;
