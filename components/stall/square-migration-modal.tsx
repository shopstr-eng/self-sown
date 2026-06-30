"use client";

import { useContext, useEffect, useMemo, useState } from "react";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Select,
  SelectItem,
  Switch,
  Progress,
} from "@heroui/react";
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  XCircleIcon,
  ArrowPathIcon,
} from "@heroicons/react/24/outline";
import {
  BLUEBUTTONCLASSNAMES,
  WHITEBUTTONCLASSNAMES,
  CATEGORIES,
  SHIPPING_OPTIONS,
} from "@/utils/STATIC-VARIABLES";
import {
  PostListing,
  getLocalStorageData,
} from "@/utils/nostr/nostr-helper-functions";
import {
  NostrContext,
  SignerContext,
} from "@/components/utility-components/nostr-context-provider";
import { ProductContext } from "@/utils/context/context";
import {
  buildListingsFromSquareItems,
  type BuiltSquareListing,
  type SquareCatalogItem,
} from "@/utils/migrations/square-to-nip99";
import { fetchSquareCatalogForImport } from "@/utils/square/client-api";
import { rehostListingImages } from "@/utils/migrations/rehost-images";
import currencySelection from "../../public/currencySelection.json";

interface SquareMigrationModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type Step = "fetch" | "configure" | "review" | "publish" | "done";

interface PublishResult {
  id: string;
  title: string;
  status: "success" | "error";
  message?: string;
  warnings?: string[];
}

const INPUT_CLASSNAMES = {
  input: "bg-white !text-black placeholder:!text-gray-500",
  inputWrapper:
    "bg-white border-2 border-black rounded-md data-[hover=true]:bg-white group-data-[focus=true]:border-primary-yellow",
  label: "text-black font-bold",
};

const SELECT_CLASSNAMES = {
  trigger:
    "bg-white border-2 border-black rounded-md data-[hover=true]:bg-white",
  value: "!text-black",
  label: "text-black font-bold",
  popoverContent: "border-2 border-black rounded-md bg-white",
  listbox: "!text-black",
};

function stepNumber(step: Step): number {
  switch (step) {
    case "fetch":
      return 1;
    case "configure":
      return 2;
    case "review":
      return 3;
    case "publish":
    case "done":
      return 4;
  }
}

export default function SquareMigrationModal({
  isOpen,
  onClose,
}: SquareMigrationModalProps) {
  const { signer, isLoggedIn, pubkey } = useContext(SignerContext);
  const { nostr } = useContext(NostrContext);
  const productEventContext = useContext(ProductContext);

  const [step, setStep] = useState<Step>("fetch");
  const [items, setItems] = useState<SquareCatalogItem[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Configuration
  const [defaultCurrency, setDefaultCurrency] = useState("USD");
  const [defaultCategory, setDefaultCategory] = useState(CATEGORIES[0] ?? "");
  const [defaultLocation, setDefaultLocation] = useState("");
  const [defaultShippingOption, setDefaultShippingOption] = useState<string>(
    SHIPPING_OPTIONS[0] ?? "Pickup"
  );
  const [defaultShippingCost, setDefaultShippingCost] = useState("0");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [pickupLocation, setPickupLocation] = useState("");

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Publish progress
  const [publishProgress, setPublishProgress] = useState(0);
  const [publishTotal, setPublishTotal] = useState(0);
  const [publishResults, setPublishResults] = useState<PublishResult[]>([]);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishStatus, setPublishStatus] = useState("");
  const [failedListings, setFailedListings] = useState<BuiltSquareListing[]>(
    []
  );

  const currencyOptions = useMemo(
    () =>
      Object.keys(currencySelection).map((code) => ({
        value: code,
        label: code,
      })),
    []
  );

  const fetchCatalog = useMemo(
    () => async () => {
      if (!signer || !isLoggedIn || !pubkey) {
        setFetchError("You must be signed in to import from Square.");
        return;
      }
      setIsFetching(true);
      setFetchError(null);
      try {
        const fetched = await fetchSquareCatalogForImport(signer, pubkey);
        setItems(fetched);
        setSelectedIds(
          new Set(fetched.filter((i) => !i.isArchived).map((i) => i.id))
        );
        setStep("configure");
      } catch (err) {
        setFetchError(
          err instanceof Error ? err.message : "Failed to load Square catalog."
        );
      } finally {
        setIsFetching(false);
      }
    },
    [signer, isLoggedIn, pubkey]
  );

  // Reset + auto-fetch when the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    setStep("fetch");
    setItems([]);
    setSelectedIds(new Set());
    setPublishResults([]);
    setFailedListings([]);
    setPublishProgress(0);
    setPublishTotal(0);
    setIsPublishing(false);
    setFetchError(null);
    void fetchCatalog();
  }, [isOpen]);

  const filteredByArchive = useMemo(() => {
    if (includeArchived) return items;
    return items.filter((i) => !i.isArchived);
  }, [items, includeArchived]);

  const productsToReview: BuiltSquareListing[] = useMemo(() => {
    const filtered = items.filter((i) => selectedIds.has(i.id));
    return buildListingsFromSquareItems(filtered, {
      pubkey: pubkey || "",
      relayHint: getLocalStorageData().relays?.[0] ?? "",
      defaultCurrency,
      defaultCategory,
      defaultLocation,
      defaultShippingOption,
      defaultShippingCost,
      pickupLocations: pickupLocation ? [pickupLocation] : [],
      includeArchived: true, // already filtered by selection above
    });
  }, [
    items,
    selectedIds,
    pubkey,
    defaultCurrency,
    defaultCategory,
    defaultLocation,
    defaultShippingOption,
    defaultShippingCost,
    pickupLocation,
  ]);

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const allSelected = filteredByArchive.every((i) => selectedIds.has(i.id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredByArchive.map((i) => i.id)));
    }
  };

  const runPublish = async (toPublish: BuiltSquareListing[]) => {
    if (!signer || !isLoggedIn || !nostr) {
      setFetchError(
        "You must be signed in to publish listings. Please sign in and try again."
      );
      return;
    }
    if (toPublish.length === 0) return;

    setStep("publish");
    setIsPublishing(true);
    setPublishProgress(0);
    setPublishTotal(toPublish.length);
    setPublishResults([]);
    setPublishStatus("");
    const results: PublishResult[] = [];
    const failures: BuiltSquareListing[] = [];

    for (let i = 0; i < toPublish.length; i++) {
      const entry = toPublish[i]!;
      const title = entry.item.name || "Untitled Square item";
      const rehostWarnings: string[] = [...entry.warnings];
      let valuesToPublish = entry.values;

      // Step A: rehost remote image URLs to the seller's Blossom server so the
      // listings keep working even if they leave Square.
      try {
        setPublishStatus(`Re-uploading images for "${title}"…`);
        const rehosted = await rehostListingImages(
          entry.values,
          signer,
          title,
          (p) => {
            setPublishStatus(
              `Re-uploading image ${Math.min(p.done + 1, p.total)} / ${p.total} for "${title}"…`
            );
          }
        );
        valuesToPublish = rehosted.values;
        rehostWarnings.push(...rehosted.warnings);
      } catch (err) {
        console.error("Image rehosting failed for", entry.item.id, err);
        rehostWarnings.push(
          `"${title}": image re-upload failed (${err instanceof Error ? err.message : "unknown error"}). Listing was published with the original Square image links.`
        );
      }

      // Step B: publish the listing to Nostr.
      try {
        setPublishStatus(`Publishing "${title}" to Nostr…`);
        const signed = await PostListing(
          valuesToPublish,
          signer,
          isLoggedIn,
          nostr
        );
        if (signed) {
          productEventContext.addNewlyCreatedProductEvent(signed);
        }
        results.push({
          id: entry.item.id,
          title,
          status: "success",
          warnings: rehostWarnings.length ? rehostWarnings : undefined,
        });
      } catch (err) {
        console.error(
          "Failed to publish migrated listing:",
          entry.item.id,
          err
        );
        results.push({
          id: entry.item.id,
          title,
          status: "error",
          message: err instanceof Error ? err.message : "Unknown error",
          warnings: rehostWarnings.length ? rehostWarnings : undefined,
        });
        failures.push(entry);
      }
      setPublishProgress(i + 1);
      setPublishResults([...results]);
    }

    setFailedListings(failures);
    setPublishStatus("");
    setIsPublishing(false);
    setStep("done");
  };

  const startPublish = () => runPublish(productsToReview);
  const retryFailed = () => runPublish(failedListings);

  const handleClose = () => {
    if (isPublishing) return;
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      backdrop="blur"
      size="3xl"
      isDismissable={!isPublishing}
      hideCloseButton={isPublishing}
      scrollBehavior="inside"
      classNames={{
        wrapper: "shadow-neo",
        base: "border-2 border-black rounded-md",
        backdrop: "bg-black/20 backdrop-blur-sm",
        header: "border-b-2 border-black bg-white rounded-t-md text-black",
        body: "py-6 bg-white",
        footer: "border-t-2 border-black bg-white rounded-b-md",
        closeButton:
          "hover:bg-gray-200 active:bg-gray-300 rounded-md text-black",
      }}
    >
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">
          <h2 className="text-xl font-bold text-black">Import from Square</h2>
          <p className="text-sm font-normal text-gray-600">
            Step {stepNumber(step)} of 4 ·{" "}
            {step === "fetch" && "Load your Square catalog"}
            {step === "configure" && "Set defaults for your listings"}
            {step === "review" && "Review what will be published"}
            {step === "publish" && "Publishing to Nostr"}
            {step === "done" && "Import complete"}
          </p>
        </ModalHeader>
        <ModalBody>
          {step === "fetch" && (
            <FetchStep
              isFetching={isFetching}
              fetchError={fetchError}
              onRetry={() => void fetchCatalog()}
            />
          )}

          {step === "configure" && (
            <div className="space-y-5">
              <ConfigDefaults
                defaultCurrency={defaultCurrency}
                setDefaultCurrency={setDefaultCurrency}
                currencyOptions={currencyOptions}
                defaultCategory={defaultCategory}
                setDefaultCategory={setDefaultCategory}
                defaultLocation={defaultLocation}
                setDefaultLocation={setDefaultLocation}
                defaultShippingOption={defaultShippingOption}
                setDefaultShippingOption={setDefaultShippingOption}
                defaultShippingCost={defaultShippingCost}
                setDefaultShippingCost={setDefaultShippingCost}
                includeArchived={includeArchived}
                setIncludeArchived={setIncludeArchived}
                pickupLocation={pickupLocation}
                setPickupLocation={setPickupLocation}
              />
              <ItemSelector
                items={filteredByArchive}
                selectedIds={selectedIds}
                toggleId={toggleId}
                toggleAll={toggleAll}
                defaultCurrency={defaultCurrency}
              />
            </div>
          )}

          {step === "review" && <ReviewStep listings={productsToReview} />}

          {step === "publish" && (
            <PublishStep
              progress={publishProgress}
              total={publishTotal}
              results={publishResults}
              status={publishStatus}
            />
          )}

          {step === "done" && <DoneStep results={publishResults} />}
        </ModalBody>
        <ModalFooter>
          {step === "fetch" && (
            <Button className={WHITEBUTTONCLASSNAMES} onClick={onClose}>
              Cancel
            </Button>
          )}

          {step === "configure" && (
            <>
              <Button
                className={WHITEBUTTONCLASSNAMES}
                onClick={() => void fetchCatalog()}
              >
                Reload
              </Button>
              <Button
                className={BLUEBUTTONCLASSNAMES}
                onClick={() => setStep("review")}
                isDisabled={selectedIds.size === 0}
              >
                Review {selectedIds.size} listing
                {selectedIds.size === 1 ? "" : "s"}
              </Button>
            </>
          )}

          {step === "review" && (
            <>
              <Button
                className={WHITEBUTTONCLASSNAMES}
                onClick={() => setStep("configure")}
              >
                Back
              </Button>
              <Button
                className={BLUEBUTTONCLASSNAMES}
                onClick={() => void startPublish()}
                isDisabled={productsToReview.length === 0}
              >
                Publish {productsToReview.length} listing
                {productsToReview.length === 1 ? "" : "s"}
              </Button>
            </>
          )}

          {step === "done" && (
            <>
              {failedListings.length > 0 && (
                <Button
                  className={WHITEBUTTONCLASSNAMES}
                  onClick={() => void retryFailed()}
                >
                  Retry {failedListings.length} failed
                </Button>
              )}
              <Button className={BLUEBUTTONCLASSNAMES} onClick={onClose}>
                Done
              </Button>
            </>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function FetchStep({
  isFetching,
  fetchError,
  onRetry,
}: {
  isFetching: boolean;
  fetchError: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="rounded-md border-2 border-black bg-yellow-50 p-4">
        <h3 className="mb-2 font-bold text-black">How Square import works</h3>
        <p className="text-sm text-black">
          We read the items from your connected Square catalog and turn them
          into Nostr listings you can publish. Connect your Square account under
          payment settings first if you haven&apos;t already.
        </p>
      </div>
      {isFetching && (
        <div className="flex items-center gap-3 text-black">
          <ArrowPathIcon className="h-5 w-5 animate-spin" />
          <span>Loading your Square catalog…</span>
        </div>
      )}
      {fetchError && (
        <div className="flex items-start gap-2 rounded-md border-2 border-red-500 bg-red-50 p-3 text-sm text-red-700">
          <XCircleIcon className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <div className="space-y-2">
            <p>{fetchError}</p>
            <Button
              size="sm"
              className={WHITEBUTTONCLASSNAMES}
              onClick={onRetry}
            >
              Try again
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigDefaults(props: {
  defaultCurrency: string;
  setDefaultCurrency: (v: string) => void;
  currencyOptions: { value: string; label: string }[];
  defaultCategory: string;
  setDefaultCategory: (v: string) => void;
  defaultLocation: string;
  setDefaultLocation: (v: string) => void;
  defaultShippingOption: string;
  setDefaultShippingOption: (v: string) => void;
  defaultShippingCost: string;
  setDefaultShippingCost: (v: string) => void;
  includeArchived: boolean;
  setIncludeArchived: (v: boolean) => void;
  pickupLocation: string;
  setPickupLocation: (v: string) => void;
}) {
  const showShippingCost =
    props.defaultShippingOption === "Added Cost" ||
    props.defaultShippingOption === "Added Cost/Pickup";
  const showPickup =
    props.defaultShippingOption === "Pickup" ||
    props.defaultShippingOption === "Free/Pickup" ||
    props.defaultShippingOption === "Added Cost/Pickup";
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Select
        label="Default currency"
        selectedKeys={[props.defaultCurrency]}
        onChange={(e) => props.setDefaultCurrency(e.target.value)}
        classNames={SELECT_CLASSNAMES}
      >
        {props.currencyOptions.map((c) => (
          <SelectItem key={c.value}>{c.label}</SelectItem>
        ))}
      </Select>
      <Select
        label="Default category"
        selectedKeys={[props.defaultCategory]}
        onChange={(e) => props.setDefaultCategory(e.target.value)}
        classNames={SELECT_CLASSNAMES}
      >
        {CATEGORIES.map((c) => (
          <SelectItem key={c}>{c}</SelectItem>
        ))}
      </Select>
      <Input
        label="Default location"
        placeholder="e.g. Austin, TX"
        value={props.defaultLocation}
        onValueChange={props.setDefaultLocation}
        classNames={INPUT_CLASSNAMES}
      />
      <Select
        label="Default shipping option"
        selectedKeys={[props.defaultShippingOption]}
        onChange={(e) => props.setDefaultShippingOption(e.target.value)}
        classNames={SELECT_CLASSNAMES}
      >
        {SHIPPING_OPTIONS.map((s) => (
          <SelectItem key={s}>{s}</SelectItem>
        ))}
      </Select>
      {showShippingCost && (
        <Input
          label="Default shipping cost"
          type="number"
          value={props.defaultShippingCost}
          onValueChange={props.setDefaultShippingCost}
          classNames={INPUT_CLASSNAMES}
        />
      )}
      {showPickup && (
        <Input
          label="Pickup location"
          placeholder="e.g. Farm stand address"
          value={props.pickupLocation}
          onValueChange={props.setPickupLocation}
          classNames={INPUT_CLASSNAMES}
        />
      )}
      <div className="flex items-center gap-3 sm:col-span-2">
        <Switch
          isSelected={props.includeArchived}
          onValueChange={props.setIncludeArchived}
        />
        <span className="text-sm text-black">
          Include archived Square items
        </span>
      </div>
    </div>
  );
}

function ItemSelector({
  items,
  selectedIds,
  toggleId,
  toggleAll,
  defaultCurrency,
}: {
  items: SquareCatalogItem[];
  selectedIds: Set<string>;
  toggleId: (id: string) => void;
  toggleAll: () => void;
  defaultCurrency: string;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-md border-2 border-black bg-white p-4 text-sm text-black">
        No Square items found in your catalog.
      </div>
    );
  }
  const allSelected = items.every((i) => selectedIds.has(i.id));
  const formatPrice = (i: SquareCatalogItem): string => {
    const priced = i.variations.find(
      (v) => typeof v.priceAmount === "number" && (v.priceAmount as number) > 0
    );
    if (!priced || priced.priceAmount == null) return "—";
    const cur = priced.priceCurrency || defaultCurrency;
    const major = priced.priceAmount / 100;
    return `${major.toFixed(2)} ${cur}`;
  };
  return (
    <div className="rounded-md border-2 border-black">
      <div className="flex items-center justify-between border-b-2 border-black bg-gray-50 px-3 py-2">
        <span className="text-sm font-bold text-black">
          {selectedIds.size} of {items.length} selected
        </span>
        <Button size="sm" className={WHITEBUTTONCLASSNAMES} onClick={toggleAll}>
          {allSelected ? "Deselect all" : "Select all"}
        </Button>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {items.map((i) => (
          <label
            key={i.id}
            className="flex cursor-pointer items-center gap-3 border-b border-gray-200 px-3 py-2 hover:bg-gray-50"
          >
            <input
              type="checkbox"
              checked={selectedIds.has(i.id)}
              onChange={() => toggleId(i.id)}
              className="h-4 w-4 accent-black"
            />
            <span className="flex-1 truncate text-sm text-black">
              {i.name || "Untitled Square item"}
              {i.isArchived && (
                <span className="ml-2 rounded bg-gray-200 px-1 text-xs text-gray-700">
                  archived
                </span>
              )}
            </span>
            <span className="text-sm text-gray-600">{formatPrice(i)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ReviewStep({ listings }: { listings: BuiltSquareListing[] }) {
  const totalWarnings = listings.reduce((sum, l) => sum + l.warnings.length, 0);
  return (
    <div className="space-y-4">
      <p className="text-sm text-black">
        {listings.length} listing{listings.length === 1 ? "" : "s"} ready to
        publish.
        {totalWarnings > 0 &&
          ` ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"} — review below.`}
      </p>
      <div className="max-h-72 space-y-2 overflow-y-auto">
        {listings.map((l) => (
          <div
            key={l.item.id}
            className="rounded-md border-2 border-black bg-white p-3"
          >
            <div className="font-bold text-black">
              {l.item.name || "Untitled Square item"}
            </div>
            {l.warnings.length > 0 && (
              <ul className="mt-1 space-y-1">
                {l.warnings.map((w, idx) => (
                  <li
                    key={idx}
                    className="flex items-start gap-1 text-xs text-yellow-700"
                  >
                    <ExclamationTriangleIcon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PublishStep({
  progress,
  total,
  results,
  status,
}: {
  progress: number;
  total: number;
  results: PublishResult[];
  status: string;
}) {
  return (
    <div className="space-y-4">
      <Progress
        aria-label="Publishing"
        value={total ? (progress / total) * 100 : 0}
        classNames={{ indicator: "bg-black" }}
      />
      <p className="text-sm text-black">
        Publishing {progress} / {total}…
      </p>
      {status && <p className="text-xs text-gray-600">{status}</p>}
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {results.map((r) => (
          <ResultRow key={r.id} result={r} />
        ))}
      </div>
    </div>
  );
}

function DoneStep({ results }: { results: PublishResult[] }) {
  const success = results.filter((r) => r.status === "success").length;
  const failed = results.filter((r) => r.status === "error").length;
  return (
    <div className="space-y-4">
      <div className="rounded-md border-2 border-black bg-green-50 p-4 text-black">
        <span className="font-bold">{success}</span> listing
        {success === 1 ? "" : "s"} published
        {failed > 0 && (
          <>
            , <span className="font-bold">{failed}</span> failed
          </>
        )}
        .
      </div>
      <div className="max-h-72 space-y-1 overflow-y-auto">
        {results.map((r) => (
          <ResultRow key={r.id} result={r} />
        ))}
      </div>
    </div>
  );
}

function ResultRow({ result }: { result: PublishResult }) {
  return (
    <div className="rounded-md border border-gray-200 px-3 py-2">
      <div className="flex items-center gap-2 text-sm text-black">
        {result.status === "success" ? (
          <CheckCircleIcon className="h-4 w-4 text-green-600" />
        ) : (
          <XCircleIcon className="h-4 w-4 text-red-600" />
        )}
        <span className="flex-1 truncate">{result.title}</span>
      </div>
      {result.message && (
        <p className="mt-1 text-xs text-red-600">{result.message}</p>
      )}
      {result.warnings?.map((w, idx) => (
        <p key={idx} className="mt-1 text-xs text-yellow-700">
          {w}
        </p>
      ))}
    </div>
  );
}
