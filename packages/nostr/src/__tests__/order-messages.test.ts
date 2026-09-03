/** @jest-environment node */

import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip44,
  SimplePool,
  verifyEvent,
  type Event,
} from "nostr-tools";
import { createHash } from "node:crypto";

import {
  createNip98AuthorizationHeader,
  createSellerMessagesListProof,
  createSellerOrderStatusGiftWrap,
  createSellerSessionFromNsec,
  generateSellerNsecCredentials,
  publishSellerOrderStatusGiftWrap,
  unwrapSellerOrderGiftWrap,
  unwrapSellerOrderGiftWraps,
  type CachedSellerGiftWrap,
} from "../index";

type GiftWrapOptions = {
  outerKind?: number;
  sealKind?: number;
  rumorKind?: number;
  outerRecipient?: string;
  rumorRecipient?: string;
  subject?: string;
  rumorPubkey?: string;
  invalidOuterSignature?: boolean;
  invalidSealSignature?: boolean;
  malformedOuterCiphertext?: boolean;
  malformedSealPlaintext?: boolean;
};

function createGiftWrap(
  session: ReturnType<typeof createSellerSessionFromNsec>,
  options: GiftWrapOptions = {}
): CachedSellerGiftWrap {
  const buyerPrivateKey = generateSecretKey();
  const buyerPubkey = getPublicKey(buyerPrivateKey);
  const outerPrivateKey = generateSecretKey();
  const createdAt = 1_750_000_000;

  const rumorTemplate = {
    pubkey: options.rumorPubkey ?? buyerPubkey,
    created_at: createdAt,
    kind: options.rumorKind ?? 14,
    tags: [
      ["p", options.rumorRecipient ?? session.pubkey],
      ["subject", options.subject ?? "order-info"],
      ["order", "order-123"],
      ["b", buyerPubkey],
      ["item", `30402:${session.pubkey}:fresh-milk`, "2"],
    ],
    content: "Product: Fresh Milk",
  };
  const rumor = {
    ...rumorTemplate,
    id: getEventHash(rumorTemplate as Event),
  };

  const sellerConversationKey = nip44.getConversationKey(
    buyerPrivateKey,
    session.pubkey
  );
  const seal = finalizeEvent(
    {
      kind: options.sealKind ?? 13,
      created_at: createdAt - 20,
      tags: [],
      content: nip44.encrypt(
        options.malformedSealPlaintext ? "not-json" : JSON.stringify(rumor),
        sellerConversationKey
      ),
    },
    buyerPrivateKey
  );
  const sealForOuter = options.invalidSealSignature
    ? { ...seal, content: `${seal.content}tampered` }
    : seal;

  const outerConversationKey = nip44.getConversationKey(
    outerPrivateKey,
    session.pubkey
  );
  const outer = finalizeEvent(
    {
      kind: options.outerKind ?? 1059,
      created_at: createdAt - 40,
      tags: [["p", options.outerRecipient ?? session.pubkey]],
      content: options.malformedOuterCiphertext
        ? "not-nip44-ciphertext"
        : nip44.encrypt(JSON.stringify(sealForOuter), outerConversationKey),
    },
    outerPrivateKey
  );
  const finalOuter = options.invalidOuterSignature
    ? { ...outer, content: `${outer.content}tampered` }
    : outer;

  // Prove the fixture itself is valid unless a test explicitly corrupts it.
  if (
    !options.invalidOuterSignature &&
    !options.malformedOuterCiphertext &&
    options.outerKind === undefined
  ) {
    expect(verifyEvent(finalOuter)).toBe(true);
  }
  return {
    ...finalOuter,
    kind: finalOuter.kind as 1059,
    is_read: false,
  };
}

describe("seller order gift-wrap verification", () => {
  const credentials = generateSellerNsecCredentials();
  const session = createSellerSessionFromNsec(credentials.nsec);

  it("verifies and decrypts a valid seller-addressed NIP-17 envelope", async () => {
    const giftWrap = createGiftWrap(session);

    await expect(
      unwrapSellerOrderGiftWrap({ session, giftWrap })
    ).resolves.toEqual({
      ok: true,
      event: expect.objectContaining({
        kind: 14,
        pubkey: expect.any(String),
        tags: expect.arrayContaining([
          ["p", session.pubkey],
          ["subject", "order-info"],
          ["order", "order-123"],
        ]),
        content: "Product: Fresh Milk",
        read: false,
        wrappedEventId: giftWrap.id,
      }),
    });
  });

  it.each([
    [
      "invalid outer signature",
      { invalidOuterSignature: true },
      "invalid-envelope",
    ],
    ["wrong outer kind", { outerKind: 1 }, "invalid-envelope"],
    [
      "wrong outer recipient",
      { outerRecipient: getPublicKey(generateSecretKey()) },
      "wrong-recipient",
    ],
    [
      "malformed outer ciphertext",
      { malformedOuterCiphertext: true },
      "invalid-envelope",
    ],
    ["invalid seal signature", { invalidSealSignature: true }, "invalid-seal"],
    ["wrong seal kind", { sealKind: 1 }, "invalid-seal"],
    ["malformed rumor JSON", { malformedSealPlaintext: true }, "invalid-rumor"],
    ["wrong rumor kind", { rumorKind: 1 }, "invalid-rumor"],
    [
      "wrong inner recipient",
      { rumorRecipient: getPublicKey(generateSecretKey()) },
      "wrong-recipient",
    ],
    [
      "rumor/author mismatch",
      { rumorPubkey: getPublicKey(generateSecretKey()) },
      "invalid-rumor",
    ],
    ["unsupported subject", { subject: "general-chat" }, "unsupported-subject"],
  ])(
    "rejects %s without returning plaintext",
    async (_label, options, reason) => {
      const result = await unwrapSellerOrderGiftWrap({
        session,
        giftWrap: createGiftWrap(session, options as GiftWrapOptions),
      });

      expect(result).toEqual({ ok: false, reason });
      expect(JSON.stringify(result)).not.toContain("Fresh Milk");
    }
  );

  it("isolates a bad envelope while retaining valid batch results", async () => {
    const first = createGiftWrap(session);
    const bad = createGiftWrap(session, {
      malformedOuterCiphertext: true,
    });
    const second = createGiftWrap(session);

    const result = await unwrapSellerOrderGiftWraps({
      session,
      giftWraps: [first, bad, second],
    });

    expect(result.events.map((event) => event.wrappedEventId)).toEqual([
      first.id,
      second.id,
    ]);
    expect(result.rejected).toEqual([
      { wrappedEventId: bad.id, reason: "invalid-envelope" },
    ]);
    expect(JSON.stringify(result.rejected)).not.toContain("Fresh Milk");
  });
});

describe("seller order request signing and status envelopes", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it("signs the exact message-list proof expected by the server", () => {
    jest.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );

    const proof = createSellerMessagesListProof(session);

    expect(verifyEvent(proof)).toBe(true);
    expect(proof).toMatchObject({
      kind: 27_235,
      pubkey: session.pubkey,
      created_at: 1_750_000_000,
      content: "",
      tags: [
        ["action", "list_messages"],
        ["method", "GET"],
        ["path", "/api/db/fetch-messages"],
        ["pubkey", session.pubkey],
      ],
    });
  });

  it("binds NIP-98 authorization to the exact URL, method, and JSON body", () => {
    jest.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );
    const body = JSON.stringify({
      orderId: "order-123",
      status: "confirmed",
      messageId: "4".repeat(64),
    });

    const header = createNip98AuthorizationHeader({
      session,
      url: "https://milk.market/api/db/update-order-status",
      method: "POST",
      body,
    });
    const encodedEvent = header.slice("Nostr ".length);
    const event = JSON.parse(
      Buffer.from(encodedEvent, "base64").toString("utf8")
    ) as Event;

    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(session.pubkey);
    expect(event.kind).toBe(27_235);
    expect(event.content).toBe("");
    expect(event.tags).toEqual([
      ["u", "https://milk.market/api/db/update-order-status"],
      ["method", "POST"],
      ["payload", createHash("sha256").update(body).digest("hex")],
    ]);
  });

  it("creates a seller-authenticated encrypted shipping update with private outer metadata", () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );
    const buyerPrivateKey = generateSecretKey();
    const buyerPubkey = getPublicKey(buyerPrivateKey);

    const giftWrap = createSellerOrderStatusGiftWrap({
      session,
      buyerPubkey,
      orderId: "order-123",
      productAddress: `30402:${session.pubkey}:fresh-milk`,
      status: "shipped",
      shipping: {
        carrier: " India Post ",
        tracking: " TRACK-123 ",
        eta: 1_751_000_000,
      },
    });

    expect(verifyEvent(giftWrap)).toBe(true);
    expect(giftWrap.kind).toBe(1059);
    expect(giftWrap.tags).toEqual([["p", buyerPubkey]]);
    expect(JSON.stringify(giftWrap.tags)).not.toContain("order-123");
    expect(JSON.stringify(giftWrap.tags)).not.toContain("TRACK-123");

    const outerConversationKey = nip44.getConversationKey(
      buyerPrivateKey,
      giftWrap.pubkey
    );
    const seal = JSON.parse(
      nip44.decrypt(giftWrap.content, outerConversationKey)
    ) as Event;
    expect(verifyEvent(seal)).toBe(true);
    expect(seal.kind).toBe(13);
    expect(seal.pubkey).toBe(session.pubkey);

    const sealConversationKey = nip44.getConversationKey(
      buyerPrivateKey,
      session.pubkey
    );
    const rumor = JSON.parse(
      nip44.decrypt(seal.content, sealConversationKey)
    ) as Event;
    expect(getEventHash(rumor)).toBe(rumor.id);
    expect(rumor).toMatchObject({
      kind: 14,
      pubkey: session.pubkey,
      content: "Your order has been shipped.",
      tags: [
        ["p", buyerPubkey],
        ["subject", "shipping-info"],
        ["order", "order-123"],
        ["item", `30402:${session.pubkey}:fresh-milk`, "1"],
        ["status", "shipped"],
        ["carrier", "India Post"],
        ["tracking", "TRACK-123"],
        ["eta", "1751000000"],
      ],
    });
  });

  it.each([
    ["bad buyer key", { buyerPubkey: "bad" }],
    ["bad order ID", { orderId: "x".repeat(129) }],
    ["foreign product", { productAddress: `30402:${"f".repeat(64)}:milk` }],
    ["oversized carrier", { shipping: { carrier: "x".repeat(81) } }],
  ])("rejects %s before constructing a status event", (_label, override) => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );
    const buyerPubkey = getPublicKey(generateSecretKey());

    expect(() =>
      createSellerOrderStatusGiftWrap({
        session,
        buyerPubkey,
        orderId: "order-123",
        productAddress: `30402:${session.pubkey}:fresh-milk`,
        status: "shipped",
        ...override,
      })
    ).toThrow("Cannot create the seller order status update");
  });

  it("caches and publishes an already-constructed status envelope", async () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec,
      { writeRelays: ["wss://relay.example"] }
    );
    const giftWrap = createSellerOrderStatusGiftWrap({
      session,
      buyerPubkey: getPublicKey(generateSecretKey()),
      orderId: "order-123",
      productAddress: `30402:${session.pubkey}:fresh-milk`,
      status: "confirmed",
    });
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true } as Response);
    global.fetch = fetchImpl as typeof fetch;
    const querySyncSpy = jest
      .spyOn(SimplePool.prototype, "querySync")
      .mockResolvedValue([]);
    const publishSpy = jest
      .spyOn(SimplePool.prototype, "publish")
      .mockReturnValue([Promise.resolve("ok")] as never);

    await expect(
      publishSellerOrderStatusGiftWrap({
        baseUrl: "http://127.0.0.1:5000",
        session,
        giftWrap,
      })
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:5000/api/db/cache-event",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(giftWrap),
      })
    );
    expect(publishSpy).toHaveBeenCalledWith(["wss://relay.example"], giftWrap);
    expect(querySyncSpy).toHaveBeenCalledWith(
      ["wss://relay.example"],
      expect.objectContaining({ kinds: [10050] }),
      expect.objectContaining({ maxWait: expect.any(Number) })
    );
  });

  it("also publishes status updates to the buyer's kind:10050 inbox relays", async () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec,
      { writeRelays: ["wss://seller-relay.example"] }
    );
    const buyerSecretKey = generateSecretKey();
    const buyerPubkey = getPublicKey(buyerSecretKey);
    const giftWrap = createSellerOrderStatusGiftWrap({
      session,
      buyerPubkey,
      orderId: "order-123",
      productAddress: `30402:${session.pubkey}:fresh-milk`,
      status: "confirmed",
    });
    const inboxList = finalizeEvent(
      {
        kind: 10050,
        created_at: 1_750_000_000,
        tags: [
          ["r", "wss://buyer-inbox.example"],
          ["r", "wss://seller-relay.example"],
          ["r", "https://not-a-relay.example"],
        ],
        content: "",
      },
      buyerSecretKey
    );
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true } as Response) as typeof fetch;
    jest
      .spyOn(SimplePool.prototype, "querySync")
      .mockResolvedValue([inboxList as Event]);
    const publishSpy = jest
      .spyOn(SimplePool.prototype, "publish")
      .mockReturnValue([Promise.resolve("ok")] as never);

    await expect(
      publishSellerOrderStatusGiftWrap({
        baseUrl: "http://127.0.0.1:5000",
        session,
        giftWrap,
      })
    ).resolves.toBeUndefined();

    expect(publishSpy).toHaveBeenCalledWith(
      ["wss://buyer-inbox.example", "wss://seller-relay.example"],
      giftWrap
    );
  });

  it("ignores forged inbox relay lists not signed by the buyer", async () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec,
      { writeRelays: ["wss://seller-relay.example"] }
    );
    const buyerPubkey = getPublicKey(generateSecretKey());
    const giftWrap = createSellerOrderStatusGiftWrap({
      session,
      buyerPubkey,
      orderId: "order-123",
      productAddress: `30402:${session.pubkey}:fresh-milk`,
      status: "confirmed",
    });
    const forgedInboxList = finalizeEvent(
      {
        kind: 10050,
        created_at: 1_750_000_000,
        tags: [["r", "wss://attacker.example"]],
        content: "",
      },
      generateSecretKey() // signed by someone other than the buyer
    );
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true } as Response) as typeof fetch;
    jest
      .spyOn(SimplePool.prototype, "querySync")
      .mockResolvedValue([forgedInboxList as Event]);
    const publishSpy = jest
      .spyOn(SimplePool.prototype, "publish")
      .mockReturnValue([Promise.resolve("ok")] as never);

    await expect(
      publishSellerOrderStatusGiftWrap({
        baseUrl: "http://127.0.0.1:5000",
        session,
        giftWrap,
      })
    ).resolves.toBeUndefined();

    expect(publishSpy).toHaveBeenCalledWith(
      ["wss://seller-relay.example"],
      giftWrap
    );
  });

  it("still publishes to seller relays when the inbox lookup fails", async () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec,
      { writeRelays: ["wss://relay.example"] }
    );
    const giftWrap = createSellerOrderStatusGiftWrap({
      session,
      buyerPubkey: getPublicKey(generateSecretKey()),
      orderId: "order-123",
      productAddress: `30402:${session.pubkey}:fresh-milk`,
      status: "confirmed",
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true } as Response) as typeof fetch;
    jest
      .spyOn(SimplePool.prototype, "querySync")
      .mockRejectedValue(new Error("relay scan failed"));
    const publishSpy = jest
      .spyOn(SimplePool.prototype, "publish")
      .mockReturnValue([Promise.resolve("ok")] as never);

    await expect(
      publishSellerOrderStatusGiftWrap({
        baseUrl: "http://127.0.0.1:5000",
        session,
        giftWrap,
      })
    ).resolves.toBeUndefined();

    expect(publishSpy).toHaveBeenCalledWith(["wss://relay.example"], giftWrap);
  });
});
