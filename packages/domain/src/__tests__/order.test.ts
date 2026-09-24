import {
  canSellerTransitionOrderStatus,
  consolidateSellerOrders,
  getNextSellerOrderStatus,
  parseSellerProductAddress,
  parseSellerOrderMessage,
  validateSellerShippingUpdate,
  type SellerOrderEvent,
} from "../index";

const sellerPubkey = "a".repeat(64);
const buyerPubkey = "b".repeat(64);
const senderPubkey = "c".repeat(64);

describe("seller product address parsing", () => {
  it("returns the validated listing coordinate parts", () => {
    expect(
      parseSellerProductAddress(
        `30402:${sellerPubkey}:fresh-milk`,
        sellerPubkey
      )
    ).toEqual({
      address: `30402:${sellerPubkey}:fresh-milk`,
      kind: 30402,
      sellerPubkey,
      dTag: "fresh-milk",
    });
  });

  it("rejects a coordinate belonging to another seller", () => {
    expect(
      parseSellerProductAddress(`30402:${buyerPubkey}:fresh-milk`, sellerPubkey)
    ).toBeNull();
  });
});

function makeOrderEvent(
  overrides: Partial<SellerOrderEvent> = {}
): SellerOrderEvent {
  return {
    id: "1".repeat(64),
    pubkey: buyerPubkey,
    created_at: 1_750_000_000,
    kind: 14,
    content: "Product: Fresh Milk",
    tags: [
      ["p", sellerPubkey],
      ["subject", "order-info"],
      ["order", "order-123"],
      ["b", buyerPubkey],
      ["item", `30402:${sellerPubkey}:fresh-milk`, "2"],
      ["amount", "24.50"],
      ["currency", "usd"],
      ["payment", "card", "reference-123"],
      ["contact", "buyer@example.com"],
      ["address", "Buyer, 1 Farm Road, Jaipur, RJ, 302001, IN"],
      ["size", "2 litre"],
      ["status", "pending"],
    ],
    read: false,
    wrappedEventId: "f".repeat(64),
    ...overrides,
  };
}

describe("seller order parsing", () => {
  it("parses a validated order addressed to the active product seller", () => {
    expect(parseSellerOrderMessage(makeOrderEvent(), sellerPubkey)).toEqual({
      sourceEventId: "1".repeat(64),
      wrappedEventId: "f".repeat(64),
      orderId: "order-123",
      subject: "order-info",
      sellerPubkey,
      buyerPubkey,
      isGuest: false,
      productAddress: `30402:${sellerPubkey}:fresh-milk`,
      productTitle: "Fresh Milk",
      quantity: 2,
      amount: 24.5,
      currency: "USD",
      status: "pending",
      paymentMethod: "card",
      paymentReference: "reference-123",
      contact: "buyer@example.com",
      address: "Buyer, 1 Farm Road, Jaipur, RJ, 302001, IN",
      selectedSize: "2 litre",
      createdAt: 1_750_000_000,
      read: false,
    });
  });

  it("accepts established order subjects without granting buyer-authored seller transitions", () => {
    const receipt = parseSellerOrderMessage(
      makeOrderEvent({
        id: "2".repeat(64),
        tags: [
          ["p", sellerPubkey],
          ["subject", "order-receipt"],
          ["order", "order-123"],
          ["b", buyerPubkey],
          ["item", `30402:${sellerPubkey}:fresh-milk`, "1"],
          ["payment", "stripe", "pi_reference", "proof"],
        ],
      }),
      sellerPubkey
    );
    const shipping = parseSellerOrderMessage(
      makeOrderEvent({
        id: "3".repeat(64),
        tags: [
          ["p", sellerPubkey],
          ["subject", "shipping-info"],
          ["order", "order-123"],
          ["b", buyerPubkey],
          ["item", `30402:${sellerPubkey}:fresh-milk`, "1"],
          ["carrier", "India Post"],
          ["tracking", "TRACK-123"],
          ["eta", "1751000000"],
        ],
      }),
      sellerPubkey
    );

    expect(receipt).toMatchObject({
      subject: "order-receipt",
      status: "pending",
      paymentMethod: "stripe",
      paymentReference: "pi_reference",
    });
    expect(shipping).toMatchObject({
      subject: "shipping-info",
      status: "pending",
      carrier: "India Post",
      tracking: "TRACK-123",
      eta: 1_751_000_000,
    });
  });

  it("tolerates legacy payment statuses without granting a seller transition", () => {
    const parsed = parseSellerOrderMessage(
      makeOrderEvent({
        tags: makeOrderEvent().tags.map((tag) =>
          tag[0] === "status" ? ["status", "paid"] : tag
        ),
      }),
      sellerPubkey
    );

    expect(parsed?.status).toBe("pending");
  });

  it("does not let an incoming order-info message grant itself a terminal status", () => {
    const parsed = parseSellerOrderMessage(
      makeOrderEvent({
        tags: makeOrderEvent().tags.map((tag) =>
          tag[0] === "status" ? ["status", "completed"] : tag
        ),
      }),
      sellerPubkey
    );

    expect(parsed?.status).toBe("pending");
  });

  it("binds an order without a buyer tag to the signed rumor author", () => {
    const parsed = parseSellerOrderMessage(
      makeOrderEvent({
        tags: makeOrderEvent().tags.filter((tag) => tag[0] !== "b"),
      }),
      sellerPubkey
    );

    expect(parsed?.buyerPubkey).toBe(buyerPubkey);
  });

  it.each([
    ["wrong event kind", { kind: 13 }],
    ["invalid event id", { id: "not-an-event-id" }],
    ["invalid author key", { pubkey: "not-a-pubkey" }],
    [
      "buyer key that does not match the signed author",
      { pubkey: senderPubkey },
    ],
    [
      "wrong seller recipient",
      {
        tags: makeOrderEvent().tags.map((tag) =>
          tag[0] === "p" ? ["p", "d".repeat(64)] : tag
        ),
      },
    ],
    [
      "wrong product seller",
      {
        tags: makeOrderEvent().tags.map((tag) =>
          tag[0] === "item"
            ? ["item", `30402:${"d".repeat(64)}:fresh-milk`, "2"]
            : tag
        ),
      },
    ],
    [
      "missing order id",
      { tags: makeOrderEvent().tags.filter((tag) => tag[0] !== "order") },
    ],
    [
      "unsupported subject",
      {
        tags: makeOrderEvent().tags.map((tag) =>
          tag[0] === "subject" ? ["subject", "general-chat"] : tag
        ),
      },
    ],
    [
      "non-finite amount",
      {
        tags: makeOrderEvent().tags.map((tag) =>
          tag[0] === "amount" ? ["amount", "Infinity"] : tag
        ),
      },
    ],
    [
      "negative amount",
      {
        tags: makeOrderEvent().tags.map((tag) =>
          tag[0] === "amount" ? ["amount", "-1"] : tag
        ),
      },
    ],
    [
      "fractional quantity",
      {
        tags: makeOrderEvent().tags.map((tag) =>
          tag[0] === "item" ? [tag[0]!, tag[1]!, "1.5"] : tag
        ),
      },
    ],
    [
      "oversized address",
      {
        tags: makeOrderEvent().tags.map((tag) =>
          tag[0] === "address" ? ["address", "x".repeat(513)] : tag
        ),
      },
    ],
  ])("rejects %s", (_label, overrides) => {
    expect(
      parseSellerOrderMessage(
        makeOrderEvent(overrides as Partial<SellerOrderEvent>),
        sellerPubkey
      )
    ).toBeNull();
  });
});

describe("seller order consolidation", () => {
  it("deterministically merges order history and keeps the server status authoritative", () => {
    const pending = parseSellerOrderMessage(makeOrderEvent(), sellerPubkey)!;
    const confirmed = parseSellerOrderMessage(
      makeOrderEvent({
        id: "2".repeat(64),
        wrappedEventId: "e".repeat(64),
        created_at: pending.createdAt + 10,
        read: true,
        tags: [
          ["p", sellerPubkey],
          ["subject", "order-receipt"],
          ["order", "order-123"],
          ["b", buyerPubkey],
          ["item", `30402:${sellerPubkey}:fresh-milk`, "2"],
          ["status", "confirmed"],
        ],
      }),
      sellerPubkey
    )!;

    const [order] = consolidateSellerOrders([confirmed, pending], {
      "order-123": "shipped",
    });

    expect(order).toMatchObject({
      orderId: "order-123",
      sellerPubkey,
      buyerPubkey,
      status: "shipped",
      createdAt: pending.createdAt,
      updatedAt: confirmed.createdAt,
      unread: true,
      sourceEventIds: [pending.sourceEventId, confirmed.sourceEventId],
      wrappedEventIds: [pending.wrappedEventId, confirmed.wrappedEventId],
    });
    expect(order?.history.map((entry) => entry.status)).toEqual([
      "pending",
      "pending",
    ]);
  });

  it("does not merge a conflicting buyer or product into an existing order", () => {
    const first = parseSellerOrderMessage(makeOrderEvent(), sellerPubkey)!;
    const conflicting = {
      ...first,
      sourceEventId: "2".repeat(64),
      buyerPubkey: "d".repeat(64),
    };

    const [order] = consolidateSellerOrders([first, conflicting]);

    expect(order?.buyerPubkey).toBe(buyerPubkey);
    expect(order?.sourceEventIds).toEqual([first.sourceEventId]);
  });

  it("does not merge a different signed author that omits the buyer tag", () => {
    const first = parseSellerOrderMessage(makeOrderEvent(), sellerPubkey)!;
    const attacker = parseSellerOrderMessage(
      makeOrderEvent({
        id: "2".repeat(64),
        pubkey: senderPubkey,
        created_at: first.createdAt + 1,
        tags: makeOrderEvent().tags.filter((tag) => tag[0] !== "b"),
      }),
      sellerPubkey
    )!;

    const [order] = consolidateSellerOrders([first, attacker]);

    expect(order?.buyerPubkey).toBe(buyerPubkey);
    expect(order?.sourceEventIds).toEqual([first.sourceEventId]);
  });
});

describe("seller order lifecycle", () => {
  it("allows only the next seller-controlled lifecycle transition", () => {
    expect(canSellerTransitionOrderStatus("pending", "confirmed")).toBe(true);
    expect(canSellerTransitionOrderStatus("confirmed", "shipped")).toBe(true);
    expect(canSellerTransitionOrderStatus("shipped", "completed")).toBe(true);

    expect(canSellerTransitionOrderStatus("pending", "shipped")).toBe(false);
    expect(canSellerTransitionOrderStatus("shipped", "confirmed")).toBe(false);
    expect(canSellerTransitionOrderStatus("completed", "completed")).toBe(
      false
    );
    expect(canSellerTransitionOrderStatus("canceled", "confirmed")).toBe(false);

    expect(getNextSellerOrderStatus("pending")).toBe("confirmed");
    expect(getNextSellerOrderStatus("confirmed")).toBe("shipped");
    expect(getNextSellerOrderStatus("shipped")).toBe("completed");
    expect(getNextSellerOrderStatus("completed")).toBeNull();
    expect(getNextSellerOrderStatus("canceled")).toBeNull();
  });

  it("normalizes bounded optional shipping fields", () => {
    expect(
      validateSellerShippingUpdate({
        carrier: "  India Post ",
        tracking: " TRACK-123 ",
        eta: 1_751_000_000,
      })
    ).toEqual({
      value: {
        carrier: "India Post",
        tracking: "TRACK-123",
        eta: 1_751_000_000,
      },
      errors: {},
    });

    expect(
      validateSellerShippingUpdate({
        carrier: "x".repeat(81),
        tracking: "line\nbreak",
        eta: -1,
      })
    ).toEqual({
      value: {},
      errors: {
        carrier: "Carrier must be 80 characters or fewer.",
        tracking: "Tracking number contains unsupported characters.",
        eta: "Estimated delivery must be a valid Unix timestamp.",
      },
    });
  });
});
