// @cashu/cashu-ts and nostr-tools (via @noble/@scure) ship ESM-only and, under
// this repo's pnpm node_modules layout, are not picked up by jest's
// transformIgnorePatterns (the resolved .pnpm symlink path contains a nested
// node_modules segment, so the negative-lookahead allowlist never matches).
// fetch-service imports both at module load (directly and transitively through
// nostr-manager / request-auth / nostr-helper-functions), but none of the code
// paths exercised by these tests use their runtime, so we stub them out to allow
// the module graph to load.
jest.mock("@cashu/cashu-ts", () => ({
  Mint: class {},
  Wallet: class {},
  hashToCurve: jest.fn(),
}));

jest.mock("uuid", () => ({
  v4: jest.fn(() => "00000000-0000-0000-0000-000000000000"),
}));

jest.mock("nostr-tools", () => ({
  SimplePool: class {},
  verifyEvent: jest.fn(() => true),
  finalizeEvent: jest.fn(),
  generateSecretKey: jest.fn(),
  getPublicKey: jest.fn(),
  getEventHash: jest.fn(),
  nip19: {
    decode: jest.fn(),
    npubEncode: jest.fn(),
    nsecEncode: jest.fn(),
    noteEncode: jest.fn(),
    neventEncode: jest.fn(),
    naddrEncode: jest.fn(),
  },
  nip44: {
    v2: {
      utils: { getConversationKey: jest.fn() },
      encrypt: jest.fn(),
      decrypt: jest.fn(),
    },
  },
}));

const makeBaseEvent = (overrides: Record<string, any> = {}) => ({
  id: "event-id",
  pubkey: "pubkey",
  created_at: 1,
  kind: 1,
  tags: [],
  content: "",
  sig: "sig",
  ...overrides,
});

const makeProductEvent = (overrides: Record<string, any> = {}) =>
  makeBaseEvent({
    kind: 30402,
    tags: [["d", "listing-1"]],
    ...overrides,
  });

const makeDbPayload = <T>(items: T[]) => ({
  ok: true,
  json: async () => items,
});

describe("fetchCart", () => {
  it("round-trips the complete address and distinguishes sellers sharing a d tag", async () => {
    const sellerA = "a".repeat(64);
    const sellerB = "b".repeat(64);
    const sharedD = "shared:listing";
    const products = [
      makeProductEvent({
        id: "product-a",
        pubkey: sellerA,
        tags: [["d", sharedD]],
      }),
      makeProductEvent({
        id: "product-b",
        pubkey: sellerB,
        tags: [["d", sharedD]],
      }),
    ];
    const savedAddress = ["a", `30402:${sellerB}:${sharedD}`];
    const signer = {
      getPubKey: jest.fn().mockResolvedValue("buyer"),
      decrypt: jest.fn().mockResolvedValue(JSON.stringify([savedAddress])),
    };
    const nostr = {
      fetch: jest.fn().mockResolvedValue([makeBaseEvent({ kind: 30405 })]),
    };
    const editCartContext = jest.fn();
    const { fetchCart } = await import("../fetch-service");

    const { cartList } = await fetchCart(
      nostr as any,
      signer as any,
      ["wss://relay.example"],
      editCartContext,
      products
    );

    expect(cartList).toHaveLength(1);
    expect(cartList[0]?.pubkey).toBe(sellerB);
    expect(cartList[0]?.id).toBe("product-b");
    expect(editCartContext).toHaveBeenCalledWith([savedAddress], false);
  });
});

describe("fetchAllFollows", () => {
  it("uses the lowest event id for conflicting equal-second contact lists", async () => {
    localStorage.setItem("wot", "1");
    const sellerA = "a".repeat(64);
    const sellerB = "b".repeat(64);
    const nostr = {
      fetch: jest
        .fn()
        .mockResolvedValueOnce([
          makeBaseEvent({
            id: "f".repeat(64),
            kind: 3,
            created_at: 10,
            tags: [["p", sellerA]],
          }),
          makeBaseEvent({
            id: "0".repeat(64),
            kind: 3,
            created_at: 10,
            tags: [["p", sellerB]],
          }),
        ])
        .mockResolvedValueOnce([]),
    };
    const editFollowsContext = jest.fn();
    const { fetchAllFollows } = await import("../fetch-service");

    await fetchAllFollows(
      nostr as any,
      ["wss://relay.example"],
      editFollowsContext,
      "viewer"
    );

    expect(editFollowsContext).toHaveBeenLastCalledWith(
      [sellerB],
      1,
      false,
      [sellerB]
    );
  });
});

describe("fetchAllPosts - NIP-99 and relay merge behavior", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("getEventKey uses d tag for kind 30402 merging", async () => {
    const cacheEventsToDatabase = jest.fn().mockResolvedValue(undefined);

    jest.doMock("@/utils/db/db-client", () => ({
      cacheEventsToDatabase,
    }));

    const { fetchAllPosts } = await import("../fetch-service");

    const cachedA = makeProductEvent({
      id: "cached-a",
      pubkey: "seller",
      created_at: 100,
      tags: [["d", "tag-1"]],
      content: "cached-a",
      sig: "sig-cached-a",
    });
    const cachedB = makeProductEvent({
      id: "cached-b",
      pubkey: "seller",
      created_at: 110,
      tags: [["d", "tag-2"]],
      content: "cached-b",
      sig: "sig-cached-b",
    });
    const relayNewForA = makeProductEvent({
      id: "relay-a",
      pubkey: "seller",
      created_at: 200,
      tags: [["d", "tag-1"]],
      content: "relay-a",
      sig: "sig-relay-a",
    });

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(makeDbPayload([cachedA, cachedB]))
      .mockResolvedValueOnce(makeDbPayload([])) as typeof global.fetch;

    const nostr = { fetch: jest.fn().mockResolvedValue([relayNewForA]) } as any;
    const editProductContext = jest.fn();

    const { productEvents, profileSetFromProducts } = await fetchAllPosts(
      nostr,
      ["wss://relay.example"],
      editProductContext
    );

    // relay should replace cachedA (same pubkey+d) but not affect cachedB (different d)
    expect(productEvents).toEqual(
      expect.arrayContaining([relayNewForA, cachedB])
    );
    expect(productEvents).not.toContain(cachedA);
    expect(cacheEventsToDatabase).toHaveBeenCalledWith([relayNewForA]);
    expect(profileSetFromProducts).toEqual(new Set(["seller"]));
  });

  it("includes kind 1 zapsnag notes alongside kind 30402 product events and caches both", async () => {
    const cacheEventsToDatabase = jest.fn().mockResolvedValue(undefined);

    jest.doMock("@/utils/db/db-client", () => ({
      cacheEventsToDatabase,
    }));

    const { fetchAllPosts } = await import("../fetch-service");

    const product = makeProductEvent({
      id: "prod-1",
      pubkey: "seller-p",
      created_at: 150,
      tags: [["d", "prod-1"]],
      content: "product",
      sig: "sig-prod-1",
    });
    const zapsnagNote = makeBaseEvent({
      id: "zapsnag-1",
      pubkey: "seller-p",
      created_at: 160,
      kind: 1,
      tags: [["t", "shopstr-zapsnag"]],
      content: "zapsnag note",
      sig: "sig-zapsnag-1",
    });

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(makeDbPayload([]))
      .mockResolvedValueOnce(makeDbPayload([])) as typeof global.fetch;

    const nostr = {
      fetch: jest.fn().mockResolvedValue([product, zapsnagNote]),
    } as any;
    const editProductContext = jest.fn();

    const { productEvents, profileSetFromProducts } = await fetchAllPosts(
      nostr,
      ["wss://relay.example"],
      editProductContext
    );

    expect(productEvents).toEqual(
      expect.arrayContaining([product, zapsnagNote])
    );
    expect(cacheEventsToDatabase).toHaveBeenCalledWith([product, zapsnagNote]);
    expect(profileSetFromProducts).toEqual(new Set(["seller-p"]));
  });

  it("prefers newer relay events over older DB events for the same NIP-99 product key", async () => {
    const cacheEventsToDatabase = jest.fn().mockResolvedValue(undefined);

    jest.doMock("@/utils/db/db-client", () => ({
      cacheEventsToDatabase,
    }));

    const { fetchAllPosts } = await import("../fetch-service");

    const dbOld = makeProductEvent({
      id: "db-old",
      pubkey: "seller-x",
      created_at: 100,
      tags: [["d", "same-key"]],
      content: "db-old",
      sig: "sig-db-old",
    });
    const relayNew = makeProductEvent({
      id: "relay-newer",
      pubkey: "seller-x",
      created_at: 300,
      tags: [["d", "same-key"]],
      content: "relay-new",
      sig: "sig-relay-new",
    });

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(makeDbPayload([dbOld]))
      .mockResolvedValueOnce(makeDbPayload([])) as typeof global.fetch;

    const nostr = { fetch: jest.fn().mockResolvedValue([relayNew]) } as any;
    const editProductContext = jest.fn();

    const { productEvents } = await fetchAllPosts(
      nostr,
      ["wss://relay.example"],
      editProductContext
    );

    expect(productEvents).toEqual(expect.arrayContaining([relayNew]));
    expect(productEvents).not.toContain(dbOld);
    expect(cacheEventsToDatabase).toHaveBeenCalledWith([relayNew]);
  });
});

describe("fetchProfile", () => {
  const pubkey =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.doMock("@/utils/nostr/badges", () => ({
      fetchNip58ProfileBadges: jest.fn().mockResolvedValue(new Map()),
    }));
  });

  it("keeps the latest kind 0 profile from the DB and ignores shop profile rows", async () => {
    const verifyNip05Identifier = jest.fn().mockResolvedValue(false);
    const cacheEventsToDatabase = jest.fn();

    jest.doMock("@/utils/nostr/nostr-helper-functions", () => ({
      getLocalStorageData: jest.fn(),
      deleteEvent: jest.fn(),
      verifyNip05Identifier,
    }));

    jest.doMock("@/utils/db/db-client", () => ({
      cacheEventsToDatabase,
    }));

    const { fetchProfile } = await import("../fetch-service");

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: "latest-user-profile",
          pubkey,
          created_at: 300,
          kind: 0,
          tags: [],
          content: JSON.stringify({
            display_name: "Latest User",
            name: "latest-user",
          }),
          sig: "sig-latest-user-profile",
        },
        {
          id: "shop-profile",
          pubkey,
          created_at: 250,
          kind: 30019,
          tags: [],
          content: JSON.stringify({
            name: "Latest Shop",
            about: "Shop profile content should not populate user settings.",
          }),
          sig: "sig-shop-profile",
        },
        {
          id: "older-user-profile",
          pubkey,
          created_at: 200,
          kind: 0,
          tags: [],
          content: JSON.stringify({
            display_name: "Older User",
            name: "older-user",
          }),
          sig: "sig-older-user-profile",
        },
      ],
    }) as typeof global.fetch;

    const editProfileContext = jest.fn();
    const nostr = {
      fetch: jest.fn().mockResolvedValue([]),
    } as any;

    const { profileMap } = await fetchProfile(
      nostr,
      ["wss://relay.example"],
      [pubkey],
      editProfileContext
    );

    expect(profileMap.get(pubkey)).toMatchObject({
      pubkey,
      created_at: 300,
      content: {
        display_name: "Latest User",
        name: "latest-user",
      },
    });
    expect(profileMap.get(pubkey)?.content.about).toBeUndefined();
    expect(editProfileContext).toHaveBeenLastCalledWith(profileMap, false);
    expect(cacheEventsToDatabase).not.toHaveBeenCalled();
  });

  it("publishes kind-0 profile state before slow NIP-58 badge hydration", async () => {
    let resolveBadges!: (value: Map<string, any>) => void;
    const fetchNip58ProfileBadges = jest.fn(
      () =>
        new Promise<Map<string, any>>((resolve) => {
          resolveBadges = resolve;
        })
    );
    jest.doMock("@/utils/nostr/badges", () => ({
      fetchNip58ProfileBadges,
    }));
    jest.doMock("@/utils/db/db-client", () => ({
      cacheEventsToDatabase: jest.fn().mockResolvedValue(undefined),
    }));

    const { fetchProfile } = await import("../fetch-service");
    global.fetch = jest.fn().mockResolvedValue(makeDbPayload([])) as typeof global.fetch;
    const editProfileContext = jest.fn();
    const nostr = {
      fetch: jest.fn().mockResolvedValue([
        makeBaseEvent({
          kind: 0,
          pubkey,
          created_at: 100,
          content: JSON.stringify({ name: "Ready before badges" }),
        }),
      ]),
    } as any;

    await fetchProfile(
      nostr,
      ["wss://slow-badge-relay.example"],
      [pubkey],
      editProfileContext
    );

    expect(editProfileContext).toHaveBeenLastCalledWith(
      expect.any(Map),
      false
    );
    expect(editProfileContext.mock.calls.at(-1)?.[0].get(pubkey)).toMatchObject({
      content: { name: "Ready before badges" },
    });
    expect(fetchNip58ProfileBadges).toHaveBeenCalled();

    resolveBadges(
      new Map([
        [pubkey, { complete: true, badges: [{ name: "Resolved badge" }] }],
      ])
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(editProfileContext.mock.calls.at(-1)?.[0].get(pubkey).badges).toEqual([
      { name: "Resolved badge" },
    ]);
  });

  it("does not let stale or incomplete badge hydration regress a newer profile", async () => {
    let resolveOldBadges!: (value: Map<string, any>) => void;
    const fetchNip58ProfileBadges = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Map<string, any>>((resolve) => {
            resolveOldBadges = resolve;
          })
      )
      .mockResolvedValueOnce(new Map([[pubkey, { complete: false, badges: [] }]]));
    jest.doMock("@/utils/nostr/badges", () => ({
      fetchNip58ProfileBadges,
    }));
    jest.doMock("@/utils/db/db-client", () => ({
      cacheEventsToDatabase: jest.fn().mockResolvedValue(undefined),
    }));

    const { fetchProfile } = await import("../fetch-service");
    global.fetch = jest.fn().mockResolvedValue(makeDbPayload([])) as typeof global.fetch;
    const editProfileContext = jest.fn();
    const nostr = {
      fetch: jest
        .fn()
        .mockResolvedValueOnce([
          makeBaseEvent({
            kind: 0,
            pubkey,
            created_at: 100,
            content: JSON.stringify({ name: "Older profile" }),
          }),
        ])
        .mockResolvedValueOnce([
          makeBaseEvent({
            kind: 0,
            pubkey,
            created_at: 200,
            content: JSON.stringify({ name: "Newer profile" }),
          }),
        ]),
    } as any;
    const existingProfiles = new Map([
      [pubkey, { pubkey, created_at: 1, content: {}, badges: [{ name: "Kept badge" }] }],
    ]);

    await fetchProfile(
      nostr,
      ["wss://relay.example"],
      [pubkey],
      editProfileContext,
      existingProfiles
    );
    await fetchProfile(
      nostr,
      ["wss://relay.example"],
      [pubkey],
      editProfileContext,
      existingProfiles
    );
    await Promise.resolve();
    await Promise.resolve();

    resolveOldBadges(
      new Map([[pubkey, { complete: true, badges: [{ name: "Stale badge" }] }]])
    );
    await Promise.resolve();
    await Promise.resolve();

    const publishedProfile = editProfileContext.mock.calls.at(-1)?.[0].get(pubkey);
    expect(publishedProfile).toMatchObject({
      created_at: 200,
      content: { name: "Newer profile" },
      badges: [{ name: "Kept badge" }],
    });
  });
});

describe("fetchAllPosts", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("merges cached and relay listings by NIP-99 address and caches only valid relay events", async () => {
    const cacheEventsToDatabase = jest.fn().mockResolvedValue(undefined);

    jest.doMock("@/utils/db/db-client", () => ({
      cacheEventsToDatabase,
    }));

    const { fetchAllPosts } = await import("../fetch-service");

    const oldCachedListing = {
      id: "cached-old",
      pubkey: "seller",
      created_at: 100,
      kind: 30402,
      tags: [["d", "listing-1"]],
      content: "",
      sig: "sig-cached-old",
    };
    const newerRelayListing = {
      id: "relay-new",
      pubkey: "seller",
      created_at: 200,
      kind: 30402,
      tags: [["d", "listing-1"]],
      content: "",
      sig: "sig-relay-new",
    };
    const relayNoteListing = {
      id: "relay-zapsnag",
      pubkey: "zapsnag-seller",
      created_at: 150,
      kind: 1,
      tags: [["t", "shopstr-zapsnag"]],
      content: "zapsnag listing",
      sig: "sig-zapsnag",
    };
    const invalidRelayListing = {
      id: "",
      pubkey: "seller",
      created_at: 300,
      kind: 30402,
      tags: [["d", "invalid"]],
      content: "",
      sig: "sig-invalid",
    };

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [oldCachedListing],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      }) as typeof global.fetch;

    const nostr = {
      fetch: jest
        .fn()
        .mockResolvedValue([
          newerRelayListing,
          relayNoteListing,
          invalidRelayListing,
        ]),
    } as any;
    const editProductContext = jest.fn();

    const { productEvents, profileSetFromProducts } = await fetchAllPosts(
      nostr,
      ["wss://relay.example"],
      editProductContext
    );

    expect(productEvents).toEqual(
      expect.arrayContaining([newerRelayListing, relayNoteListing])
    );
    expect(productEvents).not.toContain(oldCachedListing);
    expect(productEvents).not.toContain(invalidRelayListing);
    expect(profileSetFromProducts).toEqual(
      new Set(["seller", "zapsnag-seller"])
    );
    expect(editProductContext).toHaveBeenLastCalledWith(productEvents, false);
    expect(cacheEventsToDatabase).toHaveBeenCalledWith([
      newerRelayListing,
      relayNoteListing,
    ]);
  });

  it("ignores invalid relay events and never caches them", async () => {
    const cacheEventsToDatabase = jest.fn().mockResolvedValue(undefined);

    jest.doMock("@/utils/db/db-client", () => ({
      cacheEventsToDatabase,
    }));

    const { fetchAllPosts } = await import("../fetch-service");

    const validRelayListing = makeProductEvent({
      id: "relay-valid",
      pubkey: "seller-valid",
      created_at: 200,
      tags: [["d", "listing-valid"]],
      content: "",
      sig: "sig-relay-valid",
    });
    const invalidNoIdListing = makeProductEvent({
      id: "",
      pubkey: "seller-invalid-1",
      created_at: 210,
      tags: [["d", "listing-invalid-1"]],
      content: "",
      sig: "sig-invalid-1",
    });
    const invalidNoSigListing = makeProductEvent({
      id: "relay-invalid-nosig",
      pubkey: "seller-invalid-2",
      created_at: 220,
      tags: [["d", "listing-invalid-2"]],
      content: "",
      sig: "",
    });

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      }) as typeof global.fetch;

    const nostr = {
      fetch: jest
        .fn()
        .mockResolvedValue([
          validRelayListing,
          invalidNoIdListing,
          invalidNoSigListing,
        ]),
    } as any;
    const editProductContext = jest.fn();
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { productEvents, profileSetFromProducts } = await fetchAllPosts(
      nostr,
      ["wss://relay.example"],
      editProductContext
    );

    expect(cacheEventsToDatabase).toHaveBeenCalledWith([validRelayListing]);
    expect(cacheEventsToDatabase).not.toHaveBeenCalledWith(
      expect.arrayContaining([invalidNoIdListing, invalidNoSigListing])
    );
    // Downstream's merge loop uses isValidProductRelayEvent (requires id + sig +
    // pubkey), so the no-sig listing is dropped from productEvents and its pubkey
    // is excluded from profileSetFromProducts. (Upstream's merge only checks id,
    // so its expectations differ; adapted to downstream behavior.)
    expect(productEvents).toEqual([validRelayListing]);
    expect(productEvents).not.toContain(invalidNoIdListing);
    expect(productEvents).not.toContain(invalidNoSigListing);
    expect(profileSetFromProducts).toEqual(new Set(["seller-valid"]));

    consoleErrorSpy.mockRestore();
  });

  it("handles empty DB responses and empty relay responses", async () => {
    const cacheEventsToDatabase = jest.fn().mockResolvedValue(undefined);

    jest.doMock("@/utils/db/db-client", () => ({
      cacheEventsToDatabase,
    }));

    const { fetchAllPosts } = await import("../fetch-service");

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      }) as typeof global.fetch;

    const nostr = {
      fetch: jest.fn().mockResolvedValue([]),
    } as any;
    const editProductContext = jest.fn();
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { productEvents, profileSetFromProducts } = await fetchAllPosts(
      nostr,
      ["wss://relay.example"],
      editProductContext
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(nostr.fetch).toHaveBeenCalledTimes(1);
    expect(editProductContext).toHaveBeenLastCalledWith([], false);
    expect(productEvents).toEqual([]);
    expect(profileSetFromProducts).toEqual(new Set());
    expect(cacheEventsToDatabase).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});

describe("fetchGiftWrappedChatsAndMessages", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("does not call the cached message endpoint without a signer proof", async () => {
    const cacheEventsToDatabase = jest.fn().mockResolvedValue(undefined);

    jest.doMock("@/utils/db/db-client", () => ({
      cacheEventsToDatabase,
    }));

    const { fetchGiftWrappedChatsAndMessages } =
      await import("../fetch-service");

    global.fetch = jest.fn() as typeof global.fetch;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const nostr = {
      fetch: jest.fn().mockResolvedValue([]),
    } as any;
    const editChatContext = jest.fn();

    const { profileSetFromChats } = await fetchGiftWrappedChatsAndMessages(
      nostr,
      undefined,
      ["wss://relay.example"],
      editChatContext,
      "user-pubkey"
    );

    expect(global.fetch).not.toHaveBeenCalled();
    expect(nostr.fetch).toHaveBeenCalledWith(
      [{ kinds: [1059], "#p": ["user-pubkey"] }],
      {},
      ["wss://relay.example"]
    );
    expect(editChatContext).toHaveBeenCalledWith(new Map(), false);
    expect(profileSetFromChats).toEqual(new Set());
    expect(cacheEventsToDatabase).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  const makeGiftWrap = (id: string) => ({
    id,
    pubkey: `wrap-${id}`,
    created_at: 1,
    kind: 1059,
    tags: [] as string[][],
    content: `wrap:${id}`,
    sig: "sig",
  });

  const makeDbRow = (id: string) => ({
    ...makeGiftWrap(id),
    is_read: false,
  });

  // A signer that double-unwraps our synthetic wraps: `wrap:<id>` -> seal
  // (kind 13) -> rumor (kind 14, subject order-info). A wrap whose id is "bad"
  // throws on decrypt so we can prove one bad wrap doesn't sink the batch.
  const makeSigner = () =>
    ({
      sign: jest.fn().mockResolvedValue({ id: "proof", sig: "sig" }),
      decrypt: jest.fn(async (_pubkey: string, cipher: string) => {
        if (cipher.startsWith("wrap:")) {
          const id = cipher.slice("wrap:".length);
          if (id === "bad") throw new Error("cannot decrypt");
          return JSON.stringify({
            kind: 13,
            pubkey: `seal-${id}`,
            content: `seal:${id}`,
          });
        }
        if (cipher.startsWith("seal:")) {
          const id = cipher.slice("seal:".length);
          return JSON.stringify({
            pubkey: `seal-${id}`,
            created_at: 1,
            kind: 14,
            tags: [
              ["subject", "order-info"],
              ["p", "recipient"],
            ],
            content: "hi",
          });
        }
        return "";
      }),
    }) as any;

  const importFetchService = async () => {
    const cacheEventsToDatabase = jest.fn().mockResolvedValue(undefined);
    jest.doMock("@/utils/db/db-client", () => ({ cacheEventsToDatabase }));
    const mod = await import("../fetch-service");
    return { ...mod, cacheEventsToDatabase };
  };

  const lastMap = (editChatContext: jest.Mock): Map<string, unknown[]> =>
    editChatContext.mock.calls.at(-1)![0];

  it("skips a single undecryptable gift wrap instead of dropping the whole batch", async () => {
    const { fetchGiftWrappedChatsAndMessages } = await importFetchService();

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    }) as unknown as typeof global.fetch;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const nostr = {
      fetch: jest
        .fn()
        .mockResolvedValue([
          makeGiftWrap("good1"),
          makeGiftWrap("bad"),
          makeGiftWrap("good2"),
        ]),
    } as any;
    const editChatContext = jest.fn();

    const { profileSetFromChats } = await fetchGiftWrappedChatsAndMessages(
      nostr,
      makeSigner(),
      ["wss://relay.example"],
      editChatContext,
      "user-pubkey"
    );

    const map = lastMap(editChatContext);
    expect(new Set(map.keys())).toEqual(new Set(["seal-good1", "seal-good2"]));
    expect(profileSetFromChats).toEqual(new Set(["seal-good1", "seal-good2"]));
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("still renders cached messages when the relay fetch fails", async () => {
    const { fetchGiftWrappedChatsAndMessages, cacheEventsToDatabase } =
      await importFetchService();

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [makeDbRow("c1"), makeDbRow("c2")],
    }) as unknown as typeof global.fetch;
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const nostr = {
      fetch: jest.fn().mockRejectedValue(new Error("relays down")),
    } as any;
    const editChatContext = jest.fn();

    const { profileSetFromChats } = await fetchGiftWrappedChatsAndMessages(
      nostr,
      makeSigner(),
      ["wss://relay.example"],
      editChatContext,
      "user-pubkey"
    );

    const map = lastMap(editChatContext);
    expect(new Set(map.keys())).toEqual(new Set(["seal-c1", "seal-c2"]));
    expect(profileSetFromChats).toEqual(new Set(["seal-c1", "seal-c2"]));
    // Relay failure is non-fatal and there are no new relay events to persist.
    expect(cacheEventsToDatabase).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("renders cached messages first, then merges relay results (incremental)", async () => {
    const { fetchGiftWrappedChatsAndMessages, cacheEventsToDatabase } =
      await importFetchService();

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [makeDbRow("c1")],
    }) as unknown as typeof global.fetch;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const nostr = {
      fetch: jest.fn().mockResolvedValue([makeGiftWrap("r1")]),
    } as any;
    const editChatContext = jest.fn();

    await fetchGiftWrappedChatsAndMessages(
      nostr,
      makeSigner(),
      ["wss://relay.example"],
      editChatContext,
      "user-pubkey"
    );

    expect(editChatContext.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Phase 1 renders the cached message only.
    const firstMap = editChatContext.mock.calls[0][0] as Map<string, unknown[]>;
    expect(new Set(firstMap.keys())).toEqual(new Set(["seal-c1"]));
    // Final render merges cached + relay.
    const finalMap = lastMap(editChatContext);
    expect(new Set(finalMap.keys())).toEqual(new Set(["seal-c1", "seal-r1"]));
    // Only the new, signed relay wrap is persisted.
    expect(cacheEventsToDatabase).toHaveBeenCalledTimes(1);
    expect(cacheEventsToDatabase).toHaveBeenCalledWith([makeGiftWrap("r1")]);

    warnSpy.mockRestore();
  });
});

describe("fetchCashuWallet", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("returns empty wallet state without touching relays or cache when no signer pubkey is available", async () => {
    jest.doMock("@/utils/nostr/nostr-helper-functions", () => ({
      getLocalStorageData: jest.fn(() => ({
        tokens: [{ id: "local-proof", secret: "local-secret" }],
      })),
      deleteEvent: jest.fn(),
      verifyNip05Identifier: jest.fn(),
    }));
    jest.doMock("@/utils/db/db-client", () => ({
      cacheEventsToDatabase: jest.fn(),
    }));

    const { fetchCashuWallet } = await import("../fetch-service");

    global.fetch = jest.fn() as typeof global.fetch;
    const nostr = {
      fetch: jest.fn(),
    } as any;
    const editCashuWalletContext = jest.fn();

    await expect(
      fetchCashuWallet(
        nostr,
        undefined,
        ["wss://relay.example"],
        editCashuWalletContext
      )
    ).resolves.toEqual({
      proofEvents: [],
      cashuMints: [],
      cashuProofs: [],
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(nostr.fetch).not.toHaveBeenCalled();
    expect(editCashuWalletContext).toHaveBeenCalledWith([], [], [], false);
  });

  it("keeps DB-cached escrow backups out of the spendable wallet while preserving them for restore", async () => {
    // Regression: the escrow backup publish path caches to the database
    // BEFORE relay publication, so this DB branch may be the only place a
    // fresh backup is visible. The locked proofs are P2PK escrow funds —
    // they must reach proofEvents (so restoreEscrowsFromProofEvents can
    // rebuild the record) but NEVER cashuProofs (spendable balance).
    jest.doMock("@/utils/nostr/nostr-helper-functions", () => ({
      getLocalStorageData: jest.fn(() => ({ tokens: [] })),
      deleteEvent: jest.fn(),
      verifyNip05Identifier: jest.fn(),
    }));
    jest.doMock("@/utils/db/db-client", () => ({
      cacheEventsToDatabase: jest.fn(),
    }));

    const { fetchCashuWallet } = await import("../fetch-service");

    const buyerPk = "f".repeat(64);
    const escrowInfo = {
      escrowId: `${buyerPk}:order-1`,
      orderId: "order-1",
      sellerPubkey: "d".repeat(64),
      amountSats: 121,
      expiresAt: 1_900_000_000,
      createdAt: 1_800_000_000,
    };
    const lockedProofs = [
      { id: "ks", amount: 100, secret: "locked-1", C: "c1" },
      { id: "ks", amount: 21, secret: "locked-2", C: "c2" },
    ];
    const dbEvent = makeBaseEvent({
      id: "escrow-backup-event",
      kind: 7375,
      pubkey: buyerPk,
      content: "encrypted",
    });

    const signer = {
      getPubKey: async () => buyerPk,
      decrypt: async () =>
        JSON.stringify({
          mint: "https://mint.example",
          unit: "sat",
          proofs: lockedProofs,
          escrow: escrowInfo,
        }),
    };
    global.fetch = jest.fn(async () =>
      makeDbPayload([dbEvent])
    ) as unknown as typeof global.fetch;
    const nostr = { fetch: jest.fn(async () => []) } as any;
    const editCashuWalletContext = jest.fn();

    const result = await fetchCashuWallet(
      nostr,
      signer as any,
      ["wss://relay.example"],
      editCashuWalletContext
    );

    // Retained in proofEvents WITH the escrow marker for restore…
    expect(result.proofEvents).toHaveLength(1);
    expect(result.proofEvents[0]).toMatchObject({
      id: "escrow-backup-event",
      mint: "https://mint.example",
      escrow: escrowInfo,
    });
    // …but excluded from the spendable wallet.
    expect(result.cashuProofs).toEqual([]);
    expect(editCashuWalletContext).toHaveBeenCalledWith(
      result.proofEvents,
      expect.any(Array),
      [],
      false
    );
  });
});
