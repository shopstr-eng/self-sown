import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Button, Input, Spinner } from "@heroui/react";
import {
  ArrowDownTrayIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import ProtectedRoute from "@/components/utility-components/protected-route";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import {
  SUPPORTED_CARRIERS,
  ShippoDefaults,
  ShippoLabel,
  ShippoParcelTemplate,
  ShippoSpend,
  deleteShippoParcelTemplate,
  fetchShippoDefaults,
  fetchShippoLabels,
  fetchShippoSpend,
  listShippoParcelTemplates,
  saveShippoDefaults,
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
};

const EMPTY_TEMPLATE = {
  name: "",
  weightOz: "" as string | number,
  lengthIn: "" as string | number,
  widthIn: "" as string | number,
  heightIn: "" as string | number,
};

const ShippingSettingsPage = () => {
  const { signer, pubkey } = useContext(SignerContext);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [defaultsToast, setDefaultsToast] = useState<string | null>(null);

  const [defaults, setDefaults] = useState<ShippoDefaults>(EMPTY_DEFAULTS);
  const [spend, setSpend] = useState<ShippoSpend | null>(null);
  const [labels, setLabels] = useState<ShippoLabel[]>([]);
  const [templates, setTemplates] = useState<ShippoParcelTemplate[]>([]);

  const [newTemplate, setNewTemplate] = useState(EMPTY_TEMPLATE);
  const [savingTemplate, setSavingTemplate] = useState(false);

  const signerReady = !!signer?.sign && !!pubkey;

  const reload = useCallback(async () => {
    if (!signerReady || !signer || !pubkey) return;
    setLoading(true);
    setError(null);
    try {
      const [d, s, l, t] = await Promise.all([
        fetchShippoDefaults(signer, pubkey).catch(() => null),
        fetchShippoSpend(signer, pubkey).catch(() => null),
        fetchShippoLabels(signer, pubkey).catch(() => [] as ShippoLabel[]),
        listShippoParcelTemplates(signer, pubkey).catch(
          () => [] as ShippoParcelTemplate[]
        ),
      ]);
      setDefaults({ ...EMPTY_DEFAULTS, ...(d || {}) });
      setSpend(s);
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

  const toggleCarrier = (id: string) => {
    setDefaults((prev) => {
      const set = new Set(prev.preferredCarriers || []);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      const next = Array.from(set);
      return { ...prev, preferredCarriers: next.length > 0 ? next : ["USPS"] };
    });
  };

  const spendPct = useMemo(() => {
    if (!spend) return 0;
    if (spend.capUsd <= 0) return 0;
    return Math.min(100, Math.round((spend.spentUsd / spend.capUsd) * 100));
  }, [spend]);

  return (
    <ProtectedRoute>
      <div className="flex min-h-screen flex-col bg-white pt-24 pb-20">
        <div className="mx-auto w-full max-w-4xl px-4">
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
              {/* Daily spend */}
              <section className={sectionCls}>
                <h2 className="mb-3 text-xl font-bold text-black">
                  Daily Spend
                </h2>
                {spend ? (
                  <>
                    <div className="mb-2 flex items-baseline justify-between">
                      <div className="text-2xl font-bold text-black">
                        ${spend.spentUsd.toFixed(2)}{" "}
                        <span className="text-sm font-normal text-gray-600">
                          / ${spend.capUsd.toFixed(2)} cap
                        </span>
                      </div>
                      <div className="text-sm text-gray-700">
                        ${spend.remainingUsd.toFixed(2)} remaining
                      </div>
                    </div>
                    <div className="h-3 w-full overflow-hidden rounded-md border-2 border-black bg-white">
                      <div
                        className={`h-full ${
                          spendPct >= 90
                            ? "bg-red-500"
                            : spendPct >= 70
                              ? "bg-yellow-400"
                              : "bg-green-500"
                        }`}
                        style={{ width: `${spendPct}%` }}
                      />
                    </div>
                    <p className="mt-2 text-xs text-gray-600">
                      Rolling 24-hour window. Resets continuously.
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-gray-600">No spend data.</p>
                )}
              </section>

              {/* Default ship-from address */}
              <section className={sectionCls}>
                <h2 className="mb-1 text-xl font-bold text-black">
                  Default Ship-From Address
                </h2>
                <p className="mb-4 text-sm text-gray-600">
                  Pre-fills new listings and is used as the origin for return
                  labels.
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
                        setDefaults({ ...defaults, fromZip: e.target.value })
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

                <div className="mt-5 flex items-center gap-3">
                  <Button
                    className="bg-primary-yellow font-semibold text-black"
                    onPress={handleSaveDefaults}
                    isLoading={savingDefaults}
                  >
                    Save defaults
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
                      setNewTemplate({ ...newTemplate, name: e.target.value })
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
                      !newTemplate.name.trim() || !Number(newTemplate.weightOz)
                    }
                  >
                    Save template
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
                        <Button
                          variant="light"
                          isIconOnly
                          aria-label="Delete template"
                          onPress={() => handleDeleteTemplate(t.id)}
                        >
                          <TrashIcon className="h-5 w-5 text-red-600" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

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
    </ProtectedRoute>
  );
};

export default ShippingSettingsPage;
