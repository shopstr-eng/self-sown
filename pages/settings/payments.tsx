import { useContext, useEffect, useState } from "react";
import { useRouter } from "next/router";
import {
  Button,
  Input,
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
  buildStripeTaxSettingsProof,
  buildStripeDisconnectProof,
} from "@/utils/mcp/request-proof";
import StripeConnectModal from "@/components/stripe-connect/StripeConnectModal";
import MilkMarketSpinner from "@/components/utility-components/mm-spinner";
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
  const [taxError, setTaxError] = useState<string | null>(null);
  const [taxInfo, setTaxInfo] = useState<string | null>(null);

  const loadStatus = async () => {
    if (!pubkey || !signer?.sign) return;
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
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load Stripe account status"
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, signer]);

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

  useEffect(() => {
    loadSquareStatus();
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
    }
  }, [router.query.stripe]);

  // Only sellers who can take card payments can collect sales tax.
  useEffect(() => {
    if (status?.hasAccount && status.chargesEnabled) {
      loadTaxStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.hasAccount, status?.chargesEnabled]);

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
    extra?: { state?: string; registrationId?: string }
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
    const st = newState.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(st)) {
      setTaxError("Enter a valid 2-letter US state code (e.g. CA).");
      return;
    }
    setTaxBusy("add");
    setTaxError(null);
    setTaxInfo(null);
    try {
      await postTaxSettings("add_registration", { state: st });
      setNewState("");
      setTaxInfo(`Registered to collect tax in ${st}.`);
    } catch (e) {
      setTaxError(
        e instanceof Error ? e.message : "Failed to add state registration"
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
                    <div className="flex flex-col gap-2 rounded-md border-2 border-black bg-white p-4">
                      <div className="flex items-center gap-2">
                        <CreditCardIcon className="text-primary-blue h-6 w-6" />
                        <p className="font-bold text-black">Stripe</p>
                      </div>
                      <p className="flex-1 text-sm text-gray-700">
                        Card payments, payouts to your bank, and optional US
                        sales tax collection.
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

                  {!status.onboardingComplete && (
                    <div className="rounded-md border-2 border-yellow-500 bg-yellow-50 p-3 text-sm text-black">
                      Your Stripe onboarding isn&apos;t finished yet. Use
                      &quot;Finish Stripe Setup&quot; below to complete the
                      remaining steps. Once onboarding is complete, you&apos;ll
                      be able to open the full Stripe Express dashboard.
                    </div>
                  )}

                  <div className="space-y-3">
                    {status.onboardingComplete ? (
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
                              Automatically calculate and collect US sales tax
                              at checkout, based on your buyer&apos;s shipping
                              address. Only applies to single-seller card
                              (Stripe) checkouts.
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
                              Only collect tax in states where you&apos;re
                              registered with the tax authority. You are
                              responsible for filing and remitting the tax you
                              collect. Add each state where you&apos;re
                              registered below.
                            </div>

                            <div>
                              <p className="mb-2 text-sm font-bold text-black">
                                Registered states
                              </p>
                              {taxStatus.registrations.length === 0 ? (
                                <p className="text-sm text-gray-600">
                                  No states added yet. Tax won&apos;t be charged
                                  until you add at least one state.
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

                            <div className="flex items-end gap-2">
                              <Input
                                label="Add state"
                                placeholder="e.g. CA"
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
                loadStatus();
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
