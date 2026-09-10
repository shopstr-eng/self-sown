/**
 * Relay-outage resilience for cached-first fetches.
 *
 * Avatars, shop logos, and product images are seeded from the DB cache before
 * any relay request. A dead/blackholed relay must neither hang nor reject the
 * fetch in a way that wipes the cached data — relay events are only a
 * freshness upgrade.
 */
import {
  fetchAllPosts,
  fetchProfile,
  fetchShopProfile,
} from "@/utils/nostr/fetch-service";
import { NostrEvent } from "@/utils/types/types";

jest.mock("@/utils/db/db-client", () => ({
  cacheEventsToDatabase: jest.fn().mockResolvedValue(undefined),
}));

const SELLER_PUBKEY = "a".repeat(64);
const BUYER_PUBKEY = "b".repeat(64);

const profileEvent: NostrEvent = {
  id: "profile-event-id",
  pubkey: SELLER_PUBKEY,
  created_at: 1700000000,
  kind: 0,
  tags: [],
  content: JSON.stringify({
    name: "Cache Seller",
    picture: "https://example.com/avatar.png",
  }),
  sig: "sig",
} as NostrEvent;

const shopProfileEvent: NostrEvent = {
  id: "shop-event-id",
  pubkey: SELLER_PUBKEY,
  created_at: 1700000000,
  kind: 30019,
  tags: [],
  content: JSON.stringify({
    name: "Cache Shop",
    ui: { picture: "https://example.com/logo.png", theme: "classic" },
  }),
  sig: "sig",
} as NostrEvent;

const productEvent: NostrEvent = {
  id: "product-event-id",
  pubkey: SELLER_PUBKEY,
  created_at: 1700000000,
  kind: 30402,
  tags: [["d", "product-1"]],
  content: "",
  sig: "sig",
} as NostrEvent;

function mockDbFetch() {
  const mock = jest.fn((input: any) => {
    const url = String(input);
    if (url.includes("/api/db/fetch-profiles")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([profileEvent, shopProfileEvent]),
      } as Response);
    }
    if (url.includes("/api/db/fetch-products")) {
      // First batch returns the product, second (offset) batch is empty.
      const isFirstBatch = !url.includes("offset=500");
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(isFirstBatch ? [productEvent] : []),
      } as Response);
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
  (global as any).fetch = mock;
  return mock;
}

/** A NostrManager whose relays are all dead: every fetch rejects. */
function deadNostr() {
  return {
    fetch: jest.fn().mockRejectedValue(new Error("connection timed out")),
    fetchWithStatus: jest
      .fn()
      .mockResolvedValue({ events: [], complete: false }),
  } as any;
}

describe("cached-first fetch resilience to relay outages", () => {
  beforeEach(() => {
    mockDbFetch();
  });

  afterEach(() => {
    delete (global as any).fetch;
    jest.clearAllMocks();
  });

  it("fetchProfile resolves with the DB-cached profile when relays fail", async () => {
    const nostr = deadNostr();
    const contextUpdates: Map<string, any>[] = [];
    const editProfileContext = (map: Map<string, any>) => {
      contextUpdates.push(new Map(map));
    };

    const result = await fetchProfile(
      nostr,
      ["wss://dead.relay"],
      [SELLER_PUBKEY],
      editProfileContext
    );

    // The first context update must already carry the cached profile so the
    // avatar renders before/without any relay data.
    const seeded = contextUpdates[0]!.get(SELLER_PUBKEY);
    expect(seeded?.content?.picture).toBe("https://example.com/avatar.png");

    const profile = result.profileMap.get(SELLER_PUBKEY);
    expect(profile?.content?.name).toBe("Cache Seller");
    expect(profile?.content?.picture).toBe("https://example.com/avatar.png");
  });

  it("fetchShopProfile resolves with the DB-cached shop profile when relays fail", async () => {
    const nostr = deadNostr();
    const contextUpdates: Map<string, any>[] = [];
    const editShopContext = (map: Map<string, any>) => {
      contextUpdates.push(new Map(map));
    };

    const result = await fetchShopProfile(
      nostr,
      ["wss://dead.relay"],
      [SELLER_PUBKEY],
      editShopContext
    );

    const seeded = contextUpdates[0]!.get(SELLER_PUBKEY);
    expect(seeded?.content?.ui?.picture).toBe("https://example.com/logo.png");

    const shop = result.shopProfileMap.get(SELLER_PUBKEY);
    expect(shop?.content?.name).toBe("Cache Shop");
    expect(shop?.content?.ui?.picture).toBe("https://example.com/logo.png");
  });

  it("fetchAllPosts resolves with DB-cached products when relays fail", async () => {
    const nostr = deadNostr();
    const contextUpdates: NostrEvent[][] = [];
    const editProductContext = (events: NostrEvent[]) => {
      contextUpdates.push([...events]);
    };

    const result = await fetchAllPosts(
      nostr,
      ["wss://dead.relay"],
      editProductContext
    );

    expect(contextUpdates.length).toBeGreaterThan(0);
    expect(contextUpdates[0]!.map((e) => e.id)).toContain("product-event-id");
    expect(result.productEvents.map((e) => e.id)).toContain("product-event-id");
    expect(result.profileSetFromProducts.has(SELLER_PUBKEY)).toBe(true);
  });

  it("relay data still upgrades the cached profile when relays work", async () => {
    const fresherProfileEvent: NostrEvent = {
      ...profileEvent,
      id: "fresher-event-id",
      created_at: 1700001000,
      content: JSON.stringify({
        name: "Fresh Seller",
        picture: "https://example.com/fresh-avatar.png",
      }),
    };
    const nostr = {
      fetch: jest.fn().mockResolvedValue([fresherProfileEvent]),
      fetchWithStatus: jest
        .fn()
        .mockResolvedValue({ events: [], complete: false }),
    } as any;
    const editProfileContext = jest.fn();

    const result = await fetchProfile(
      nostr,
      ["wss://healthy.relay"],
      [SELLER_PUBKEY],
      editProfileContext
    );

    expect(result.profileMap.get(SELLER_PUBKEY)?.content?.picture).toBe(
      "https://example.com/fresh-avatar.png"
    );
  });

  it("requests a bounded, timeout-resolving relay fetch", async () => {
    const nostr = deadNostr();
    await fetchProfile(nostr, ["wss://dead.relay"], [BUYER_PUBKEY], jest.fn());
    await fetchShopProfile(
      nostr,
      ["wss://dead.relay"],
      [BUYER_PUBKEY],
      jest.fn()
    );

    for (const call of nostr.fetch.mock.calls) {
      const options = call[3];
      expect(options?.resolveOnTimeout).toBe(true);
      expect(typeof options?.timeout).toBe("number");
      expect(options.timeout).toBeGreaterThan(0);
    }
  });
});
