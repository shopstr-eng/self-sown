import AsyncStorage from "@react-native-async-storage/async-storage";

// Mobile port of utils/nostr/saved-address-helpers.ts. Saved addresses are
// device-local on web (localStorage) and stay device-local on mobile
// (AsyncStorage) — but scoped per seller pubkey, since several seller
// accounts can sign in on the same device and one account must never see
// another's names/street addresses. The single-default invariant matches the
// web exactly.
const SAVED_ADDRESSES_STORAGE_PREFIX = "self-sown:saved-addresses";
// Unscoped key written only by the unreleased first cut of this feature. It
// cannot be safely attributed to any one account, so it is deleted on sight
// rather than migrated to whichever account happens to sign in next.
const LEGACY_SAVED_ADDRESSES_KEY = "self-sown:saved-addresses";

function storageKey(pubkey: string): string {
  return `${SAVED_ADDRESSES_STORAGE_PREFIX}:${pubkey}`;
}

export interface SavedAddress {
  id: string;
  label: string;
  name: string;
  address: string;
  unit?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  isDefault: boolean;
}

export type SavedAddressDraft = Omit<SavedAddress, "id"> & { id?: string };

export type SavedAddressValidationErrors = Partial<
  Record<"label" | "name" | "address" | "city" | "state" | "zip" | "country", string>
>;

let idCounter = 0;

function createAddressId(): string {
  idCounter += 1;
  return `addr-${Date.now().toString(36)}-${idCounter.toString(
    36
  )}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// Exactly one address is always the default once any address exists: prefer
// the requested id, else keep the existing default, else fall back to the
// first entry. Mirrors ensureSingleDefault on web.
export function ensureSingleDefault(
  addresses: SavedAddress[],
  preferredId?: string
): SavedAddress[] {
  if (addresses.length === 0) return addresses;

  const preferred =
    preferredId !== undefined && addresses.some((a) => a.id === preferredId);
  const existingDefault = addresses.find((a) => a.isDefault)?.id;
  const fallbackId = preferred
    ? preferredId!
    : existingDefault || addresses[0]!.id;

  return addresses.map((a) => ({ ...a, isDefault: a.id === fallbackId }));
}

function isSavedAddress(value: unknown): value is SavedAddress {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.address === "string" &&
    typeof candidate.city === "string" &&
    typeof candidate.state === "string" &&
    typeof candidate.zip === "string" &&
    typeof candidate.country === "string" &&
    typeof candidate.isDefault === "boolean"
  );
}

export async function getSavedAddresses(
  pubkey: string
): Promise<SavedAddress[]> {
  try {
    // Never read the legacy unscoped key — its owner is unknowable. Clear it
    // so stale PII does not linger on shared devices.
    await AsyncStorage.removeItem(LEGACY_SAVED_ADDRESSES_KEY);
    const raw = await AsyncStorage.getItem(storageKey(pubkey));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedAddress);
  } catch {
    return [];
  }
}

async function persist(
  pubkey: string,
  addresses: SavedAddress[]
): Promise<void> {
  await AsyncStorage.setItem(storageKey(pubkey), JSON.stringify(addresses));
}

export function validateSavedAddressDraft(
  draft: SavedAddressDraft
): SavedAddressValidationErrors {
  const errors: SavedAddressValidationErrors = {};
  if (!draft.label.trim()) errors.label = "Label is required";
  if (!draft.name.trim()) errors.name = "Name is required";
  if (!draft.address.trim()) errors.address = "Address is required";
  if (!draft.city.trim()) errors.city = "City is required";
  if (!draft.state.trim()) errors.state = "State is required";
  if (!draft.zip.trim()) errors.zip = "Zip code is required";
  if (!draft.country.trim()) errors.country = "Country is required";
  return errors;
}

export async function saveAddress(
  pubkey: string,
  draft: SavedAddressDraft
): Promise<SavedAddress[]> {
  const addresses = await getSavedAddresses(pubkey);
  const toSave: SavedAddress = {
    ...draft,
    id: draft.id || createAddressId(),
  };

  let next = addresses.map((a) =>
    toSave.isDefault ? { ...a, isDefault: false } : a
  );

  const existingIndex = next.findIndex((a) => a.id === toSave.id);
  if (existingIndex >= 0) {
    next[existingIndex] = toSave;
  } else {
    next = [...next, toSave];
  }

  next = ensureSingleDefault(
    next,
    toSave.isDefault ? toSave.id : undefined
  );

  await persist(pubkey, next);
  return next;
}

export async function deleteAddress(
  pubkey: string,
  id: string
): Promise<SavedAddress[]> {
  const addresses = await getSavedAddresses(pubkey);
  const next = ensureSingleDefault(addresses.filter((a) => a.id !== id));
  await persist(pubkey, next);
  return next;
}

export async function setDefaultAddress(
  pubkey: string,
  id: string
): Promise<SavedAddress[]> {
  const addresses = await getSavedAddresses(pubkey);
  const next = ensureSingleDefault(addresses, id);
  await persist(pubkey, next);
  return next;
}
