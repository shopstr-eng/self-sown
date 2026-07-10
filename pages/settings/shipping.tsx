import { useCallback, useContext, useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
} from "@heroui/react";
import {
  ArrowDownTrayIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import ProtectedRoute from "@/components/utility-components/protected-route";
import { SettingsBreadCrumbs } from "@/components/settings/settings-bread-crumbs";
import {
  NostrContext,
  SignerContext,
} from "@/components/utility-components/nostr-context-provider";
import { ProductContext } from "@/utils/context/context";
import parseTags from "@/utils/parsers/product-parser-functions";
import { republishProductWithParcel } from "@/utils/nostr/nostr-helper-functions";
import { NostrEvent } from "@/utils/types/types";
import { useProMembership } from "@/components/utility-components/pro-membership-context";
import UpgradeBanner from "@/components/pro/upgrade-banner";
import {
  SUPPORTED_CARRIERS,
  ShippoConnectionStatus,
  ShippoDefaults,
  ShippoLabel,
  ShippoParcelTemplate,
  deleteShippoParcelTemplate,
  disconnectShippo,
  fetchShippoConnectionStatus,
  fetchShippoDefaults,
  fetchShippoLabels,
  listShippoParcelTemplates,
  saveShippoDefaults,
  startShippoOAuth,
  upsertShippoParcelTemplate,
} from "@/utils/shipping/client-api";

const inputCls = {
  input: "text-base !text-black",
  inputWrapper:
    "border-2 border-black rounded-md shadow-none !bg-white data-[hover=true]:!bg-white data-[focus=true]:!bg-white",
};

const sectionCls = "shadow-neo rounded-md border-2 border-black bg-white p-5";

const EMPTY_DEFAULTS: ShippoDefaults = {
  fromName: "",
  fromCompany: "",
  fromStreet1: "",
  fromStreet2: "",
  fromCity: "",
  fromState: "",
  fromZip: "",
  fromCountry: "US",
  fromPhone: "",
  fromEmail: "",
  preferredCarriers: ["USPS"],
  autoPurchaseLabels: true,
};

const EMPTY_TEMPLATE = {
  name: "",
  weightOz: "" as string | number,
  lengthIn: "" as string | number,
  widthIn: "" as string | number,
  heightIn: "" as string | number,
};

type MyProductRow = {
  event: NostrEvent;
  title: string;
  parcelSummary: string;
  hasShipFromZip: boolean;
  usesLiveRates: boolean;
};

const ShippingSettingsPage = () => {
  const { signer, pubkey } = useContext(SignerContext);
  const { nostr } = useContext(NostrContext);
  const {
    productEvents,
    addNewlyCreatedProductEvent,
    removeDeletedProductEvent,
  } = useContext(ProductContext);
  const { membership } = useProMembership();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [defaultsToast, setDefaultsToast] = useState<string | null>(null);

  const [defaults, setDefaults] = useState<ShippoDefaults>(EMPTY_DEFAULTS);
  const [connection, setConnection] = useState<ShippoConnectionStatus | null>(
    null
  );
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [labels, setLabels] = useState<ShippoLabel[]>([]);
  const [templates, setTemplates] = useState<ShippoParcelTemplate[]>([]);

  const [newTemplate, setNewTemplate] = useState(EMPTY_TEMPLATE);
  const [savingTemplate, setSavingTemplate] = useState(false);

  const [applyTemplate, setApplyTemplate] =
    useState<ShippoParcelTemplate | null>(null);
  const [modalProducts, setModalProducts] = useState<MyProductRow[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<Set<string>>(
    new Set()
  );
  const [applying, setApplying] = useState(false);
  const [applyResults, setApplyResults] = useState<
    Record<string, "ok" | "error">
  >({});

  const signerReady = !!signer?.sign && !!pubkey;

  const reload = useCallback(async () => {
    if (!signerReady || !signer || !pubkey) return;
    setLoading(true);
    setError(null);
    try {
      const [d, c, l, t] = await Promise.all([
        fetchShippoDefaults(signer, pubkey).catch(() => null),
        fetchShippoConnectionStatus(signer, pubkey).catch(() => null),
        fetchShippoLabels(signer, pubkey).catch(() => [] as ShippoLabel[]),
        listShippoParcelTemplates(signer, pubkey).catch(
          () => [] as ShippoParcelTemplate[]
        ),
      ]);
      setDefaults({ ...EMPTY_DEFAULTS, ...(d || {}) });
      setConnection(c);
      setLabels(l);
      setTemplates(t);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load shipping settings"
      );
    } finally {
      setLoading(false);
    }
  }, [signer, pubkey, signerReady]);

  useEffect(() => {
    if (signerReady) reload();
    else setLoading(false);
  }, [signerReady, reload]);

  const handleSaveDefaults = async () => {
    if (!signer || !pubkey) return;
    setSavingDefaults(true);
    setDefaultsToast(null);
    try {
      const saved = await saveShippoDefaults(signer, pubkey, defaults);
      setDefaults({ ...EMPTY_DEFAULTS, ...saved });
      setDefaultsToast("Saved.");
      setTimeout(() => setDefaultsToast(null), 3000);
    } catch (e) {
      setDefaultsToast(
        e instanceof Error ? e.message : "Failed to save defaults"
      );
    } finally {
      setSavingDefaults(false);
    }
  };

  const handleAddTemplate = async () => {
    if (!signer || !pubkey) return;
    const weight = Number(newTemplate.weightOz);
    if (!newTemplate.name.trim() || !Number.isFinite(weight) || weight <= 0) {
      return;
    }
    setSavingTemplate(true);
    try {
      const t = await upsertShippoParcelTemplate(signer, pubkey, {
        name: newTemplate.name.trim(),
        weightOz: weight,
        lengthIn: newTemplate.lengthIn ? Number(newTemplate.lengthIn) : null,
        widthIn: newTemplate.widthIn ? Number(newTemplate.widthIn) : null,
        heightIn: newTemplate.heightIn ? Number(newTemplate.heightIn) : null,
      });
      setTemplates((prev) => {
        const others = prev.filter((p) => p.id !== t.id);
        return [...others, t].sort((a, b) => a.name.localeCompare(b.name));
      });
      setNewTemplate(EMPTY_TEMPLATE);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save template");
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleDeleteTemplate = async (id: number) => {
    if (!signer || !pubkey) return;
    try {
      await deleteShippoParcelTemplate(signer, pubkey, id);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete template");
    }
  };

  // Build the list of the seller's OWN listings (kind 30402) with a short
  // package + shipping summary, so they can pick which ones to apply a parcel
  // template to from this page.
  const buildMyProducts = useCallback((): MyProductRow[] => {
    if (!pubkey) return [];
    return productEvents
      .filter((e) => e.kind === 30402 && e.pubkey === pubkey)
      .flatMap((event) => {
        let p;
        try {
          p = parseTags(event);
        } catch {
          return [];
        }
        if (!p) return [];
        const dims =
          p.packageLengthIn && p.packageWidthIn && p.packageHeightIn
            ? ` • ${p.packageLengthIn}×${p.packageWidthIn}×${p.packageHeightIn} in`
            : "";
        const parcelSummary = p.packageWeightOz
          ? `${p.packageWeightOz} oz${dims}`
          : "No package size set";
        return [
          {
            event,
            title: p.title || "Untitled listing",
            parcelSummary,
            hasShipFromZip: !!p.shipFromZip,
            usesLiveRates:
              p.shippingType === "Added Cost" ||
              p.shippingType === "Added Cost/Pickup" ||
              p.shippingType === "Free",
          },
        ];
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [productEvents, pubkey]);

  const openApplyModal = (t: ShippoParcelTemplate) => {
    setApplyTemplate(t);
    // Freeze the list while the modal is open so per-row results stay aligned
    // even as we update the product cache after applying.
    setModalProducts(buildMyProducts());
    setSelectedProductIds(new Set());
    setApplyResults({});
  };

  const closeApplyModal = () => {
    if (applying) return;
    setApplyTemplate(null);
    setModalProducts([]);
    setSelectedProductIds(new Set());
    setApplyResults({});
  };

  const toggleProduct = (id: string) => {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleApplyTemplate = async () => {
    if (!signer || !pubkey || !nostr || !applyTemplate) return;
    const targets = modalProducts.filter((p) =>
      selectedProductIds.has(p.event.id)
    );
    if (targets.length === 0) return;
    setApplying(true);
    const results: Record<string, "ok" | "error"> = {};
    const succeeded: { oldId: string; signed: NostrEvent }[] = [];
    for (const target of targets) {
      try {
        const signed = await republishProductWithParcel(
          target.event,
          {
            weightOz: applyTemplate.weightOz,
            lengthIn: applyTemplate.lengthIn,
            widthIn: applyTemplate.widthIn,
            heightIn: applyTemplate.heightIn,
          },
          signer,
          nostr,
          {
            shipFromZip: defaults.fromZip,
            shipFromCountry: defaults.fromCountry,
          }
        );
        if (signed) {
          results[target.event.id] = "ok";
          succeeded.push({
            oldId: target.event.id,
            signed: signed as NostrEvent,
          });
        } else {
          results[target.event.id] = "error";
        }
      } catch {
        results[target.event.id] = "error";
      }
      setApplyResults({ ...results });
    }
    // Update the local product cache only after the batch finishes so the
    // frozen modal list (and its per-row status) stays stable while we work.
    for (const s of succeeded) {
      removeDeletedProductEvent(s.oldId);
      addNewlyCreatedProductEvent(s.signed);
    }
    setApplying(false);
  };

  const toggleCarrier = (id: string) => {
    setDefaults((prev) => {
      const set = new Set(prev.preferredCarriers || []);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      const next = Array.from(set);
      return { ...prev, preferredCarriers: next.length > 0 ? next : ["USPS"] };
    });
  };

  const handleConnect = async () => {
    if (!signer || !pubkey) return;
    setConnecting(true);
    setError(null);
    try {
      const authorizeUrl = await startShippoOAuth(signer, pubkey);
      window.location.href = authorizeUrl;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to start Shippo connection"
      );
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!signer || !pubkey) return;
    setDisconnecting(true);
    setError(null);
    try {
      await disconnectShippo(signer, pubkey);
      await reload();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to disconnect Shippo account"
      );
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <ProtectedRoute>
      <div className="flex min-h-screen flex-col bg-white pt-24 pb-20">
        <div className="mx-auto w-full max-w-4xl px-4">
          <SettingsBreadCrumbs />
          <h1 className="mb-2 text-4xl font-bold text-black">Shipping</h1>
          <p className="mb-6 text-sm text-gray-600">
            Manage your default ship-from address, parcel templates, carrier
            preferences, and view purchased labels.
          </p>

          {!signerReady && (
            <div className="mb-4 rounded-md border-2 border-black bg-yellow-50 p-4 text-sm text-black">
              Sign in with your Nostr key to manage shipping settings.
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center py-12">
              <Spinner />
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-md border-2 border-black bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}

          {!loading && signerReady && (
            <div className="space-y-6">
              {!membership.isPro && (
                <UpgradeBanner
                  className="mb-2"
                  feature="Shippo shipping labels"
                />
              )}
              {membership.isPro && (
                <>
                  {/* Shippo account connection */}
                  <section className={sectionCls}>
                    <h2 className="mb-1 text-xl font-bold text-black">
                      Shippo Account
                    </h2>
                    <p className="mb-4 text-sm text-gray-600">
                      Connect your own Shippo account to buy shipping labels.
                      Shippo bills your account directly, and the marketplace
                      never charges you for shipping.
                    </p>
                    {connection && !connection.configured ? (
                      <div className="rounded-md border-2 border-black bg-yellow-50 p-3 text-sm text-black">
                        Shipping is not configured on this marketplace yet.
                        Check back later.
                      </div>
                    ) : connection?.connected ? (
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="font-semibold text-green-700">
                            Connected to Shippo
                          </p>
                          {connection.accountId && (
                            <p className="text-xs text-gray-600">
                              Account: {connection.accountId}
                            </p>
                          )}
                          {connection.connectedAt && (
                            <p className="text-xs text-gray-600">
                              Connected{" "}
                              {new Date(
                                connection.connectedAt
                              ).toLocaleDateString()}
                            </p>
                          )}
                        </div>
                        <Button
                          className="border-2 border-black bg-white font-semibold text-black"
                          onPress={handleDisconnect}
                          isLoading={disconnecting}
                          isDisabled={disconnecting}
                        >
                          Disconnect
                        </Button>
                      </div>
                    ) : (
                      <Button
                        className="bg-primary-yellow border-2 border-black font-semibold text-black"
                        onPress={handleConnect}
                        isLoading={connecting}
                        isDisabled={connecting}
                      >
                        Connect Shippo account
                      </Button>
                    )}
                  </section>

                  {/* Default ship-from address */}
                  <section className={sectionCls}>
                    <h2 className="mb-1 text-xl font-bold text-black">
                      Default Ship-From Address
                    </h2>
                    <p className="mb-4 text-sm text-gray-600">
                      Pre-fills new listings and is used as the origin for
                      return labels.
                    </p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Input
                        classNames={inputCls}
                        label="Name"
                        labelPlacement="outside"
                        placeholder="Your name"
                        value={defaults.fromName || ""}
                        onChange={(e) =>
                          setDefaults({ ...defaults, fromName: e.target.value })
                        }
                      />
                      <Input
                        classNames={inputCls}
                        label="Company (optional)"
                        labelPlacement="outside"
                        placeholder=""
                        value={defaults.fromCompany || ""}
                        onChange={(e) =>
                          setDefaults({
                            ...defaults,
                            fromCompany: e.target.value,
                          })
                        }
                      />
                      <Input
                        classNames={inputCls}
                        label="Street"
                        labelPlacement="outside"
                        placeholder="123 Main St"
                        value={defaults.fromStreet1 || ""}
                        onChange={(e) =>
                          setDefaults({
                            ...defaults,
                            fromStreet1: e.target.value,
                          })
                        }
                      />
                      <Input
                        classNames={inputCls}
                        label="Apt/Suite (optional)"
                        labelPlacement="outside"
                        placeholder=""
                        value={defaults.fromStreet2 || ""}
                        onChange={(e) =>
                          setDefaults({
                            ...defaults,
                            fromStreet2: e.target.value,
                          })
                        }
                      />
                      <Input
                        classNames={inputCls}
                        label="City"
                        labelPlacement="outside"
                        placeholder=""
                        value={defaults.fromCity || ""}
                        onChange={(e) =>
                          setDefaults({ ...defaults, fromCity: e.target.value })
                        }
                      />
                      <div className="grid grid-cols-2 gap-3">
                        <Input
                          classNames={inputCls}
                          label="State"
                          labelPlacement="outside"
                          placeholder="CA"
                          value={defaults.fromState || ""}
                          onChange={(e) =>
                            setDefaults({
                              ...defaults,
                              fromState: e.target.value,
                            })
                          }
                        />
                        <Input
                          classNames={inputCls}
                          label="ZIP"
                          labelPlacement="outside"
                          placeholder="90210"
                          value={defaults.fromZip || ""}
                          onChange={(e) =>
                            setDefaults({
                              ...defaults,
                              fromZip: e.target.value,
                            })
                          }
                        />
                      </div>
                      <Input
                        classNames={inputCls}
                        label="Country"
                        labelPlacement="outside"
                        placeholder="US"
                        value={defaults.fromCountry || "US"}
                        onChange={(e) =>
                          setDefaults({
                            ...defaults,
                            fromCountry: e.target.value.toUpperCase(),
                          })
                        }
                      />
                      <Input
                        classNames={inputCls}
                        label="Phone (optional)"
                        labelPlacement="outside"
                        placeholder=""
                        value={defaults.fromPhone || ""}
                        onChange={(e) =>
                          setDefaults({
                            ...defaults,
                            fromPhone: e.target.value,
                          })
                        }
                      />
                    </div>

                    <div className="mt-4">
                      <p className="mb-2 text-sm font-semibold text-black">
                        Preferred Carriers
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {SUPPORTED_CARRIERS.map((c) => {
                          const active = (
                            defaults.preferredCarriers || []
                          ).includes(c.id);
                          return (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => toggleCarrier(c.id)}
                              className={`rounded-md border-2 border-black px-3 py-1.5 text-sm font-semibold ${
                                active
                                  ? "bg-primary-yellow text-black"
                                  : "bg-white text-black hover:bg-gray-100"
                              }`}
                            >
                              {c.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="mt-5 rounded-md border-2 border-black bg-white p-3">
                      <Checkbox
                        isSelected={defaults.autoPurchaseLabels !== false}
                        onValueChange={(checked) =>
                          setDefaults({
                            ...defaults,
                            autoPurchaseLabels: checked,
                          })
                        }
                      >
                        <span className="text-sm font-semibold text-black">
                          Automatically buy shipping labels for paid orders
                        </span>
                      </Checkbox>
                      <p className="mt-1 text-xs text-gray-600">
                        When on, paid card and agent orders shipping to the US
                        automatically buy the cheapest label from your preferred
                        carriers on your connected Shippo account. Turn off to
                        buy labels yourself from the Orders dashboard.
                      </p>
                    </div>

                    <div className="mt-5 flex items-center gap-3">
                      <Button
                        className="bg-primary-yellow font-semibold text-black"
                        onPress={handleSaveDefaults}
                        isLoading={savingDefaults}
                      >
                        Save Defaults
                      </Button>
                      {defaultsToast && (
                        <span className="text-sm text-gray-700">
                          {defaultsToast}
                        </span>
                      )}
                    </div>
                  </section>

                  {/* Parcel templates */}
                  <section className={sectionCls}>
                    <h2 className="mb-1 text-xl font-bold text-black">
                      Parcel Templates
                    </h2>
                    <p className="mb-4 text-sm text-gray-600">
                      Save package sizes you ship often so you can reuse them on
                      listings without re-entering dimensions.
                    </p>

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-6">
                      <Input
                        classNames={inputCls}
                        label="Name"
                        labelPlacement="outside"
                        placeholder="Small box"
                        className="sm:col-span-2"
                        value={newTemplate.name}
                        onChange={(e) =>
                          setNewTemplate({
                            ...newTemplate,
                            name: e.target.value,
                          })
                        }
                      />
                      <Input
                        classNames={inputCls}
                        label="Weight oz"
                        labelPlacement="outside"
                        type="number"
                        placeholder="16"
                        value={String(newTemplate.weightOz)}
                        onChange={(e) =>
                          setNewTemplate({
                            ...newTemplate,
                            weightOz: e.target.value,
                          })
                        }
                      />
                      <Input
                        classNames={inputCls}
                        label="L (in)"
                        labelPlacement="outside"
                        type="number"
                        placeholder=""
                        value={String(newTemplate.lengthIn)}
                        onChange={(e) =>
                          setNewTemplate({
                            ...newTemplate,
                            lengthIn: e.target.value,
                          })
                        }
                      />
                      <Input
                        classNames={inputCls}
                        label="W (in)"
                        labelPlacement="outside"
                        type="number"
                        placeholder=""
                        value={String(newTemplate.widthIn)}
                        onChange={(e) =>
                          setNewTemplate({
                            ...newTemplate,
                            widthIn: e.target.value,
                          })
                        }
                      />
                      <Input
                        classNames={inputCls}
                        label="H (in)"
                        labelPlacement="outside"
                        type="number"
                        placeholder=""
                        value={String(newTemplate.heightIn)}
                        onChange={(e) =>
                          setNewTemplate({
                            ...newTemplate,
                            heightIn: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="mt-3">
                      <Button
                        className="bg-primary-yellow font-semibold text-black"
                        startContent={<PlusIcon className="h-4 w-4" />}
                        onPress={handleAddTemplate}
                        isLoading={savingTemplate}
                        isDisabled={
                          !newTemplate.name.trim() ||
                          !Number(newTemplate.weightOz)
                        }
                      >
                        Save Template
                      </Button>
                    </div>

                    {templates.length > 0 && (
                      <div className="mt-5 divide-y-2 divide-black overflow-hidden rounded-md border-2 border-black">
                        {templates.map((t) => (
                          <div
                            key={t.id}
                            className="flex items-center justify-between bg-white p-3"
                          >
                            <div>
                              <div className="font-semibold text-black">
                                {t.name}
                              </div>
                              <div className="text-sm text-gray-600">
                                {t.weightOz} oz
                                {t.lengthIn && t.widthIn && t.heightIn
                                  ? ` • ${t.lengthIn}×${t.widthIn}×${t.heightIn} in`
                                  : ""}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                className="border-2 border-black bg-white font-semibold text-black"
                                onPress={() => openApplyModal(t)}
                              >
                                Apply To Listings
                              </Button>
                              <Button
                                variant="light"
                                isIconOnly
                                aria-label="Delete template"
                                onPress={() => handleDeleteTemplate(t.id)}
                              >
                                <TrashIcon className="h-5 w-5 text-red-600" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </>
              )}

              {/* Label history */}
              <section className={sectionCls}>
                <h2 className="mb-1 text-xl font-bold text-black">
                  Label History
                </h2>
                <p className="mb-4 text-sm text-gray-600">
                  All shipping labels you&apos;ve purchased. Re-download PDFs or
                  follow tracking links anytime.
                </p>

                {labels.length === 0 ? (
                  <p className="text-sm text-gray-600">No labels yet.</p>
                ) : (
                  <div className="divide-y-2 divide-black overflow-hidden rounded-md border-2 border-black">
                    {labels.map((l) => (
                      <div
                        key={l.id}
                        className="flex flex-col gap-2 bg-white p-3 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-black">
                              {l.carrier} {l.service}
                            </span>
                            {l.isReturn && (
                              <span className="rounded-md border border-black bg-orange-100 px-1.5 py-0.5 text-xs font-semibold text-black">
                                RETURN
                              </span>
                            )}
                            <span className="text-sm text-gray-700">
                              ${l.rateUsd.toFixed(2)} {l.currency}
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-gray-600">
                            {new Date(l.purchasedAt).toLocaleString()}
                            {l.toSummary ? ` • To: ${l.toSummary}` : ""}
                          </div>
                          {l.trackingCode && (
                            <div className="mt-0.5 text-xs">
                              Tracking:{" "}
                              {l.trackingUrl ? (
                                <a
                                  href={l.trackingUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-700 underline"
                                >
                                  {l.trackingCode}
                                </a>
                              ) : (
                                l.trackingCode
                              )}
                            </div>
                          )}
                        </div>
                        <a
                          href={l.labelUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="bg-primary-yellow inline-flex items-center gap-1 self-start rounded-md border-2 border-black px-3 py-1.5 text-sm font-semibold text-black hover:bg-yellow-300 sm:self-auto"
                        >
                          <ArrowDownTrayIcon className="h-4 w-4" />
                          {l.labelFormat || "PDF"}
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>

      {/* Apply a parcel template to existing listings */}
      <Modal
        isOpen={applyTemplate !== null}
        onClose={closeApplyModal}
        size="2xl"
        scrollBehavior="inside"
        classNames={{ base: "border-2 border-black" }}
      >
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1 text-black">
            <span>Apply &ldquo;{applyTemplate?.name}&rdquo; to listings</span>
            <span className="text-sm font-normal text-gray-600">
              Sets the package size ({applyTemplate?.weightOz} oz
              {applyTemplate?.lengthIn &&
              applyTemplate?.widthIn &&
              applyTemplate?.heightIn
                ? ` • ${applyTemplate.lengthIn}×${applyTemplate.widthIn}×${applyTemplate.heightIn} in`
                : ""}
              ) on the listings you choose, so buyers see live USPS rates at
              checkout.
            </span>
          </ModalHeader>
          <ModalBody>
            {modalProducts.length === 0 ? (
              <p className="text-sm text-gray-600">
                You don&apos;t have any listings yet.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-gray-600">
                    {selectedProductIds.size} selected
                  </p>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      className="text-sm font-semibold text-blue-700 underline disabled:opacity-50"
                      disabled={applying}
                      onClick={() =>
                        setSelectedProductIds(
                          new Set(modalProducts.map((p) => p.event.id))
                        )
                      }
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      className="text-sm font-semibold text-blue-700 underline disabled:opacity-50"
                      disabled={applying}
                      onClick={() => setSelectedProductIds(new Set())}
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className="divide-y-2 divide-black overflow-hidden rounded-md border-2 border-black">
                  {modalProducts.map((p) => {
                    const result = applyResults[p.event.id];
                    return (
                      <div
                        key={p.event.id}
                        className="flex items-start gap-3 bg-white p-3"
                      >
                        <Checkbox
                          isSelected={selectedProductIds.has(p.event.id)}
                          onValueChange={() => toggleProduct(p.event.id)}
                          isDisabled={applying}
                          aria-label={`Select ${p.title}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold text-black">
                            {p.title}
                          </div>
                          <div className="text-sm text-gray-600">
                            {p.parcelSummary}
                          </div>
                          {!p.usesLiveRates && (
                            <div className="mt-0.5 text-xs text-gray-500">
                              This listing&apos;s shipping type doesn&apos;t use
                              live rates, so the package size won&apos;t change
                              checkout.
                            </div>
                          )}
                          {p.usesLiveRates &&
                            !p.hasShipFromZip &&
                            !!defaults.fromZip?.trim() && (
                              <div className="mt-0.5 text-xs text-gray-500">
                                Applying will also set this listing&apos;s ship
                                from to your default ZIP ({defaults.fromZip}) so
                                live rates can calculate.
                              </div>
                            )}
                          {p.usesLiveRates &&
                            !p.hasShipFromZip &&
                            !defaults.fromZip?.trim() && (
                              <div className="mt-0.5 text-xs text-orange-700">
                                Set a &ldquo;Ship From&rdquo; ZIP in your
                                Shipping defaults above (or the listing editor)
                                to enable live rates.
                              </div>
                            )}
                        </div>
                        {result === "ok" && (
                          <span className="text-sm font-semibold text-green-700">
                            Updated
                          </span>
                        )}
                        {result === "error" && (
                          <span className="text-sm font-semibold text-red-700">
                            Failed
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              className="border-2 border-black bg-white font-semibold text-black"
              onPress={closeApplyModal}
              isDisabled={applying}
            >
              Close
            </Button>
            <Button
              className="bg-primary-yellow border-2 border-black font-semibold text-black"
              onPress={handleApplyTemplate}
              isLoading={applying}
              isDisabled={applying || selectedProductIds.size === 0}
            >
              Apply to {selectedProductIds.size} listing
              {selectedProductIds.size === 1 ? "" : "s"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </ProtectedRoute>
  );
};

export default ShippingSettingsPage;
