/** @jest-environment node */

jest.mock("react-native", () => ({ Platform: { OS: "web" } }), {
  virtual: true,
});

const asyncStorageStore = new Map<string, string>();

jest.mock(
  "@react-native-async-storage/async-storage",
  () => ({
    getItem: jest.fn(async (key: string) => asyncStorageStore.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      asyncStorageStore.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      asyncStorageStore.delete(key);
    }),
  }),
  { virtual: true }
);

import {
  buildMarketProfileContent,
  createMarketProfileDraft,
  deriveMarketPaymentPreference,
  validateMarketProfileDraft,
  type MarketProfileDraft,
} from "@/apps/mobile/lib/market-profile";
import type { SellerSession } from "@self-sown/domain";

import {
  loadAccountPreferences,
  moveMintToFront,
  validateBlossomServerUrl,
  validateMintUrl,
  validateRelayUrl,
} from "@/apps/mobile/lib/account-settings";
import {
  deleteAddress,
  ensureSingleDefault,
  getSavedAddresses,
  saveAddress,
  setDefaultAddress,
  validateSavedAddressDraft,
  type SavedAddress,
} from "@/apps/mobile/lib/saved-addresses";

const baseDraft: MarketProfileDraft = {
  picture: "https://example.com/pic.png",
  displayName: "Self-sown Farm",
  username: "selfsown",
  nip05: "farm@example.com",
  lud16: "farm@wallet.example.com",
  donationPercent: "2.5",
  fiatOptions: { cash: "available", venmo: "@farm" },
};

describe("market profile drafts", () => {
  it("hydrates from kind:0 content and migrates the legacy donation key", () => {
    const draft = createMarketProfileDraft({
      display_name: "Farm",
      name: "farm",
      mm_donation: 3,
      fiat_options: { cash: "available", unknown_key: "nope" },
    });

    expect(draft.displayName).toBe("Farm");
    expect(draft.username).toBe("farm");
    expect(draft.donationPercent).toBe("3");
    expect(draft.fiatOptions).toEqual({ cash: "available" });
  });

  it("prefers ss_donation over the legacy mm_donation key", () => {
    const draft = createMarketProfileDraft({
      ss_donation: 5,
      mm_donation: 9,
    });
    expect(draft.donationPercent).toBe("5");
  });

  it("derives the payment preference exactly like the web form", () => {
    expect(deriveMarketPaymentPreference("farm@wallet.com", true)).toBe(
      "lightning"
    );
    expect(deriveMarketPaymentPreference("", true)).toBe("ecash");
    expect(deriveMarketPaymentPreference("farm@zeuspay.com", true)).toBe(
      "ecash"
    );
    expect(deriveMarketPaymentPreference("farm@wallet.com", false)).toBe(
      "fiat"
    );
  });

  it("rejects non-numeric and out-of-range donations, allows blank", () => {
    expect(
      validateMarketProfileDraft({ ...baseDraft, donationPercent: "" })
    ).toEqual({});
    expect(
      validateMarketProfileDraft({ ...baseDraft, donationPercent: "0" })
    ).toEqual({});
    expect(
      validateMarketProfileDraft({ ...baseDraft, donationPercent: "abc" })
        .donationPercent
    ).toBeTruthy();
    expect(
      validateMarketProfileDraft({ ...baseDraft, donationPercent: "101" })
        .donationPercent
    ).toBeTruthy();
    expect(
      validateMarketProfileDraft({ ...baseDraft, donationPercent: "-1" })
        .donationPercent
    ).toBeTruthy();
  });

  it("builds kind:0 content preserving unknown fields and dropping legacy donation keys", () => {
    const content = buildMarketProfileContent(
      {
        about: "We grow things.",
        website: "https://farm.example.com",
        shopstr_donation: 1,
        mm_donation: 2,
      },
      { ...baseDraft, donationPercent: "" },
      true
    );

    expect(content.about).toBe("We grow things.");
    expect(content.website).toBe("https://farm.example.com");
    expect(content.display_name).toBe("Self-sown Farm");
    expect(content.ss_donation).toBe(0);
    expect(content.shopstr_donation).toBeUndefined();
    expect(content.mm_donation).toBeUndefined();
    expect(content.payment_preference).toBe("lightning");
    expect(content.fiat_options).toEqual({
      cash: "available",
      venmo: "@farm",
    });
  });
});

const fakeSession = (
  pubkey: string,
  overrides: Partial<SellerSession> = {}
): SellerSession => ({
  authMethod: "nsec",
  pubkey,
  nsec: "nsec1fake",
  relays: [],
  writeRelays: [],
  createdAt: 0,
  ...overrides,
});

describe("account preferences", () => {
  const PUBKEY = "c".repeat(64);

  beforeEach(() => {
    asyncStorageStore.clear();
  });

  it("treats a fresh sign-in's publish targets as shared relays, not a write-only list", async () => {
    // Sign-in initializes session.writeRelays = session.relays; the write-only
    // NIP-65 category must still start empty so relays are not listed twice.
    const session = fakeSession(PUBKEY, {
      relays: ["wss://relay-a.example.com", "wss://relay-b.example.com"],
      writeRelays: ["wss://relay-a.example.com", "wss://relay-b.example.com"],
    });

    const preferences = await loadAccountPreferences(session);

    expect(preferences.writeRelays).toEqual([]);
    expect(preferences.readRelays).toEqual([]);
  });

  it("restores an explicitly saved write-only list", async () => {
    asyncStorageStore.set(
      `self-sown:account:write-relays:${PUBKEY}`,
      JSON.stringify(["wss://write-only.example.com"])
    );

    const preferences = await loadAccountPreferences(
      fakeSession(PUBKEY, {
        relays: ["wss://relay-a.example.com"],
        writeRelays: ["wss://relay-a.example.com"],
      })
    );

    expect(preferences.writeRelays).toEqual(["wss://write-only.example.com"]);
  });
});

describe("account settings validators", () => {
  it("requires wss/ws relay URLs within the length cap", () => {
    expect(validateRelayUrl("")).toBeTruthy();
    expect(validateRelayUrl("https://relay.example.com")).toBeTruthy();
    expect(validateRelayUrl("wss://relay.example.com")).toBeNull();
    expect(validateRelayUrl("ws://relay.example.com")).toBeNull();
    expect(validateRelayUrl(`wss://${"a".repeat(600)}`)).toBeTruthy();
  });

  it("requires http(s) mint and Blossom URLs", () => {
    expect(validateMintUrl("wss://mint.example.com")).toBeTruthy();
    expect(validateMintUrl("https://mint.example.com")).toBeNull();
    expect(validateBlossomServerUrl("ftp://cdn.example.com")).toBeTruthy();
    expect(validateBlossomServerUrl("https://cdn.example.com")).toBeNull();
  });

  it("moves the active mint to the front without duplicating it", () => {
    expect(
      moveMintToFront(
        ["https://a.example.com", "https://b.example.com"],
        "https://b.example.com"
      )
    ).toEqual(["https://b.example.com", "https://a.example.com"]);
    expect(moveMintToFront([], "https://a.example.com")).toEqual([
      "https://a.example.com",
    ]);
  });
});

describe("saved addresses", () => {
  const PUBKEY_A = "a".repeat(64);
  const PUBKEY_B = "b".repeat(64);

  const address = (
    id: string,
    isDefault: boolean,
    label = id
  ): SavedAddress => ({
    id,
    label,
    name: "Buyer",
    address: "1 Farm Rd",
    city: "Town",
    state: "ST",
    zip: "12345",
    country: "US",
    isDefault,
  });

  beforeEach(() => {
    asyncStorageStore.clear();
  });

  it("validates required fields", () => {
    const errors = validateSavedAddressDraft({
      label: "",
      name: "",
      address: "",
      city: "",
      state: "",
      zip: "",
      country: "",
      isDefault: false,
    });
    expect(Object.keys(errors).sort()).toEqual([
      "address",
      "city",
      "country",
      "label",
      "name",
      "state",
      "zip",
    ]);
  });

  it("enforces exactly one default address", () => {
    const result = ensureSingleDefault([
      address("a", true),
      address("b", true),
    ]);
    expect(result.filter((entry) => entry.isDefault)).toHaveLength(1);
    expect(ensureSingleDefault([address("a", false)])[0]?.isDefault).toBe(true);
    expect(
      ensureSingleDefault([address("a", true), address("b", false)], "b").find(
        (entry) => entry.isDefault
      )?.id
    ).toBe("b");
  });

  it("saves, defaults, and deletes addresses with the single-default invariant", async () => {
    let addresses = await saveAddress(PUBKEY_A, {
      label: "Home",
      name: "Buyer",
      address: "1 Farm Rd",
      city: "Town",
      state: "ST",
      zip: "12345",
      country: "US",
      isDefault: false,
    });
    // The first address becomes the default automatically.
    expect(addresses).toHaveLength(1);
    expect(addresses[0]?.isDefault).toBe(true);

    const firstId = addresses[0]!.id;
    addresses = await saveAddress(PUBKEY_A, {
      label: "Office",
      name: "Buyer",
      address: "2 Barn Ln",
      city: "Town",
      state: "ST",
      zip: "12345",
      country: "US",
      isDefault: true,
    });
    expect(addresses).toHaveLength(2);
    expect(addresses.filter((entry) => entry.isDefault)).toHaveLength(1);
    const office = addresses.find((entry) => entry.label === "Office")!;
    expect(office.isDefault).toBe(true);

    // Switching the default moves it back.
    addresses = await setDefaultAddress(PUBKEY_A, firstId);
    expect(addresses.find((entry) => entry.id === firstId)?.isDefault).toBe(
      true
    );
    expect(office.isDefault).toBe(true); // stale local copy untouched

    // Deleting the default promotes another address instead of leaving none.
    addresses = await deleteAddress(PUBKEY_A, firstId);
    expect(addresses).toHaveLength(1);
    expect(addresses[0]?.isDefault).toBe(true);

    const persisted = await getSavedAddresses(PUBKEY_A);
    expect(persisted).toEqual(addresses);
  });

  it("drops malformed entries instead of crashing", async () => {
    asyncStorageStore.set(
      `self-sown:saved-addresses:${PUBKEY_A}`,
      JSON.stringify([address("ok", true), { bogus: true }, "nope"])
    );
    const addresses = await getSavedAddresses(PUBKEY_A);
    expect(addresses).toHaveLength(1);
    expect(addresses[0]?.id).toBe("ok");
  });

  it("never exposes one account's addresses or preferences to another account on the same device", async () => {
    await saveAddress(PUBKEY_A, {
      label: "Home",
      name: "Buyer A",
      address: "1 Farm Rd",
      city: "Town",
      state: "ST",
      zip: "12345",
      country: "US",
      isDefault: true,
    });
    asyncStorageStore.set(
      `self-sown:account:mints:${PUBKEY_A}`,
      JSON.stringify(["https://mint-a.example.com"])
    );

    // A different account signing in on the same device sees none of it —
    // not even the write-only relay list, which starts empty regardless of
    // the new session's publish targets.
    expect(await getSavedAddresses(PUBKEY_B)).toEqual([]);
    const preferencesB = await loadAccountPreferences(
      fakeSession(PUBKEY_B, { writeRelays: ["wss://relay-b.example.com"] })
    );
    expect(preferencesB.mints).toEqual([]);
    expect(preferencesB.writeRelays).toEqual([]);

    // The first account's data is still intact for its own session.
    expect(await getSavedAddresses(PUBKEY_A)).toHaveLength(1);
    const preferencesA = await loadAccountPreferences(fakeSession(PUBKEY_A));
    expect(preferencesA.mints).toEqual(["https://mint-a.example.com"]);
  });

  it("deletes the legacy unscoped keys instead of attributing them to the next signed-in account", async () => {
    asyncStorageStore.set(
      "self-sown:saved-addresses",
      JSON.stringify([address("legacy", true)])
    );
    asyncStorageStore.set(
      "self-sown:account:mints",
      JSON.stringify(["https://legacy-mint.example.com"])
    );

    expect(await getSavedAddresses(PUBKEY_A)).toEqual([]);
    expect(asyncStorageStore.has("self-sown:saved-addresses")).toBe(false);

    const preferences = await loadAccountPreferences(fakeSession(PUBKEY_A));
    expect(preferences.mints).toEqual([]);
    expect(asyncStorageStore.has("self-sown:account:mints")).toBe(false);
  });
});
