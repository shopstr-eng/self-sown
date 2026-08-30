/** @jest-environment node */

import { SimplePool } from "nostr-tools";

import {
  SellerNostrError,
  cacheSignedEvent,
  createSellerActionAuthEventTemplate,
  createSellerListingDeleteEventTemplate,
  createSellerListingEventTemplate,
  createSellerSessionFromNsec,
  createSignedSellerActionAuthEvent,
  createSignedStorefrontSlugAuthEvent,
  createSignedStripeConnectAuthEvent,
  deleteSellerListing,
  deserializeSellerSession,
  generateSellerNsecCredentials,
  publishSignedEvent,
  publishSellerListing,
  signEventTemplate,
  serializeSellerSession,
  uploadSellerListingMedia,
  validateSellerNsec,
} from "../index";

describe("seller nostr helpers", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
  });

  test("generates and validates seller nsec credentials", () => {
    const credentials = generateSellerNsecCredentials();
    const validation = validateSellerNsec(credentials.nsec);

    expect(validation).toEqual({
      valid: true,
      normalized: credentials.nsec,
      pubkey: credentials.pubkey,
    });
  });

  test("serializes and restores seller sessions", () => {
    const { nsec, pubkey } = generateSellerNsecCredentials();
    const session = createSellerSessionFromNsec(nsec, {
      authMethod: "email",
      email: "seller@example.com",
      relays: ["wss://relay.damus.io"],
      writeRelays: ["wss://relay.primal.net"],
    });

    expect(session.pubkey).toBe(pubkey);
    expect(deserializeSellerSession(serializeSellerSession(session))).toEqual(
      session
    );
  });

  test("creates a signed stripe auth event for the seller session", () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );

    const event = createSignedStripeConnectAuthEvent(session);

    expect(event.kind).toBe(27235);
    expect(event.pubkey).toBe(session.pubkey);
    expect(event.tags).toEqual([["action", "stripe-connect"]]);
    expect(event.content).toBe("Authorize Stripe Connect account management");
  });

  test("creates generic signed auth events for seller-owned actions", () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );

    const event = createSignedSellerActionAuthEvent(
      session,
      "notification-email-write"
    );

    expect(event.kind).toBe(27235);
    expect(event.pubkey).toBe(session.pubkey);
    expect(event.tags).toEqual([["action", "notification-email-write"]]);
    expect(event.content).toBe("Authorize notification email updates");
  });

  test("binds storefront slug authorization to the exact API request", () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );

    const event = createSignedStorefrontSlugAuthEvent(
      session,
      "POST",
      "milk-market-farm"
    );

    expect(event.tags).toEqual([
      ["action", "storefront-slug-write"],
      ["method", "POST"],
      ["path", "/api/storefront/register-slug"],
      ["field", "slug", "milk-market-farm"],
    ]);

    expect(() =>
      createSignedStorefrontSlugAuthEvent(session, "POST", "")
    ).toThrow("A storefront slug is required");
  });

  test("builds auth templates for non-stripe actions", () => {
    const template = createSellerActionAuthEventTemplate(
      "seller-pubkey",
      "storefront-slug-write"
    );

    expect(template.pubkey).toBe("seller-pubkey");
    expect(template.tags).toEqual([["action", "storefront-slug-write"]]);
    expect(template.content).toBe("Authorize storefront slug updates");
  });

  test("throws when caching a signed event fails", async () => {
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: false,
    } as Response);
    global.fetch = fetchSpy as typeof fetch;

    await expect(
      cacheSignedEvent("http://127.0.0.1:5000", {
        id: "event-1",
        pubkey: "seller-pubkey",
        created_at: 1710000000,
        kind: 30019,
        tags: [["d", "seller-pubkey"]],
        content: "{}",
      })
    ).rejects.toThrow(
      new SellerNostrError("Failed to cache the signed event.")
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:5000/api/db/cache-event",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  test("builds a seller listing event template with published_at metadata", () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );

    const template = createSellerListingEventTemplate(session, [
      ["d", "listing-d-tag"],
      ["summary", "Fresh milk."],
    ]);

    expect(template.kind).toBe(30402);
    expect(template.pubkey).toBe(session.pubkey);
    expect(template.content).toBe("Fresh milk.");
    expect(template.tags).toEqual(
      expect.arrayContaining([
        ["d", "listing-d-tag"],
        ["summary", "Fresh milk."],
        ["published_at", expect.any(String)],
      ])
    );
  });

  test("creates a seller listing delete event template", () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );

    const template = createSellerListingDeleteEventTemplate(session, [
      "listing-event",
    ]);

    expect(template.kind).toBe(5);
    expect(template.pubkey).toBe(session.pubkey);
    expect(template.tags).toEqual([["e", "listing-event"]]);
  });

  test("accepts a relay publish when at least one relay acknowledges it", async () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec,
      {
        writeRelays: ["wss://relay-one.example", "wss://relay-two.example"],
      }
    );
    const event = signEventTemplate(
      session,
      createSellerListingEventTemplate(session, [["d", "listing-d-tag"]])
    );
    jest
      .spyOn(SimplePool.prototype, "publish")
      .mockReturnValue([
        Promise.reject(new Error("relay one failed")),
        Promise.resolve("ok"),
      ] as never);

    await expect(publishSignedEvent(session, event)).resolves.toBeUndefined();
  });

  test("rejects a relay publish when no relay acknowledges it", async () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );
    const event = signEventTemplate(
      session,
      createSellerListingEventTemplate(session, [["d", "listing-d-tag"]])
    );
    jest
      .spyOn(SimplePool.prototype, "publish")
      .mockReturnValue([
        Promise.reject(new Error("sensitive relay details")),
      ] as never);

    await expect(publishSignedEvent(session, event)).rejects.toThrow(
      new SellerNostrError(
        "The signed event could not be published to any relay."
      )
    );
  });

  test("rejects a relay publish when the pool returns no attempts", async () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );
    const event = signEventTemplate(
      session,
      createSellerListingEventTemplate(session, [["d", "listing-d-tag"]])
    );
    jest.spyOn(SimplePool.prototype, "publish").mockReturnValue([] as never);

    await expect(publishSignedEvent(session, event)).rejects.toThrow(
      new SellerNostrError(
        "The signed event could not be published to any relay."
      )
    );
  });

  test("publishes seller listings with cached main, recommendation, and handler events", async () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ success: true }),
    } as Response);
    const publishSpy = jest
      .spyOn(SimplePool.prototype, "publish")
      .mockReturnValue([Promise.resolve("ok")] as never);
    global.fetch = fetchSpy as typeof fetch;

    const listingEvent = await publishSellerListing({
      baseUrl: "http://127.0.0.1:5000",
      session,
      draft: {
        title: "Fresh milk",
        description: "Daily delivery.",
        images: ["https://example.com/milk.jpg"],
        price: "15",
        currency: "USD",
        categories: ["Milk"],
        location: "Jaipur",
        shippingType: "Free",
        shippingCost: "",
        pickupLocations: [],
        quantity: "2",
        status: "active",
      },
    });

    expect(listingEvent.kind).toBe(30402);
    expect(listingEvent.tags).toEqual(
      expect.arrayContaining([
        ["title", "Fresh milk"],
        ["status", "active"],
        ["published_at", expect.any(String)],
      ])
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(publishSpy).toHaveBeenCalledTimes(3);
  });

  test("new listings with the same title still get different d tags", async () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ success: true }),
    } as Response);
    const publishSpy = jest
      .spyOn(SimplePool.prototype, "publish")
      .mockReturnValue([Promise.resolve("ok")] as never);
    global.fetch = fetchSpy as typeof fetch;

    const firstEvent = await publishSellerListing({
      baseUrl: "http://127.0.0.1:5000",
      session,
      draft: {
        title: "Fresh milk",
        description: "Morning batch.",
        images: ["https://example.com/milk.jpg"],
        price: "15",
        currency: "USD",
        categories: ["Milk"],
        location: "Jaipur",
        shippingType: "Free",
        shippingCost: "",
        pickupLocations: [],
        quantity: "2",
        status: "active",
      },
    });

    const secondEvent = await publishSellerListing({
      baseUrl: "http://127.0.0.1:5000",
      session,
      draft: {
        title: "Fresh milk",
        description: "Evening batch.",
        images: ["https://example.com/milk-2.jpg"],
        price: "16",
        currency: "USD",
        categories: ["Milk"],
        location: "Jaipur",
        shippingType: "Free",
        shippingCost: "",
        pickupLocations: [],
        quantity: "3",
        status: "active",
      },
    });

    expect(firstEvent.tags.find((tag) => tag[0] === "d")?.[1]).not.toEqual(
      secondEvent.tags.find((tag) => tag[0] === "d")?.[1]
    );
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    expect(publishSpy).toHaveBeenCalledTimes(6);
  });

  test("publishing an updated listing preserves the d tag and deletes the old cached event", async () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
      json: async () => ({ success: true }),
    } as Response);
    const publishSpy = jest
      .spyOn(SimplePool.prototype, "publish")
      .mockReturnValue([Promise.resolve("ok")] as never);
    global.fetch = fetchSpy as typeof fetch;

    const listingEvent = await publishSellerListing({
      baseUrl: "http://127.0.0.1:5000",
      session,
      existingEventId: "old-listing-event",
      existingDTag: "stable-d-tag",
      draft: {
        eventId: "old-listing-event",
        dTag: "stable-d-tag",
        title: "Updated fresh milk",
        description: "Now with pickup.",
        images: ["https://example.com/milk.jpg"],
        price: "16",
        currency: "USD",
        categories: ["Milk"],
        location: "Jaipur",
        shippingType: "Pickup",
        shippingCost: "",
        pickupLocations: ["Farm gate"],
        quantity: "3",
        status: "inactive",
      },
    });

    expect(listingEvent.tags).toEqual(
      expect.arrayContaining([["d", "stable-d-tag"]])
    );
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "http://127.0.0.1:5000/api/db/delete-events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-signed-event": expect.any(String),
        }),
        body: JSON.stringify({ eventIds: ["old-listing-event"] }),
      })
    );
    const deleteRequest = fetchSpy.mock.calls.at(-1)?.[1] as
      | RequestInit
      | undefined;
    const deleteHeaders = deleteRequest?.headers as
      | Record<string, string>
      | undefined;
    const signedDeleteEvent = JSON.parse(
      deleteHeaders?.["x-signed-event"] ?? "{}"
    ) as { kind: number; pubkey: string; tags: string[][] };
    expect(signedDeleteEvent.kind).toBe(27235);
    expect(signedDeleteEvent.pubkey).toBe(session.pubkey);
    expect(signedDeleteEvent.tags).toEqual(
      expect.arrayContaining([
        ["action", "delete_cached_events"],
        ["method", "POST"],
        ["path", "/api/db/delete-events"],
        ["pubkey", session.pubkey],
        ["eventIds", "old-listing-event"],
      ])
    );
  });

  test("deletes seller listings by caching a delete event and deleting the cached event", async () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );
    const fetchSpy = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "",
        json: async () => ({ success: true }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "",
        json: async () => ({ success: true }),
      } as Response);
    jest
      .spyOn(SimplePool.prototype, "publish")
      .mockReturnValue([Promise.resolve("ok")] as never);
    global.fetch = fetchSpy as typeof fetch;

    const deleteEvent = await deleteSellerListing({
      baseUrl: "http://127.0.0.1:5000",
      session,
      eventId: "listing-event",
    });

    expect(deleteEvent.kind).toBe(5);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "http://127.0.0.1:5000/api/db/delete-events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-signed-event": expect.any(String),
        }),
      })
    );
    const deleteRequest = fetchSpy.mock.calls.at(-1)?.[1] as
      | RequestInit
      | undefined;
    const deleteHeaders = deleteRequest?.headers as
      | Record<string, string>
      | undefined;
    const signedDeleteEvent = JSON.parse(
      deleteHeaders?.["x-signed-event"] ?? "{}"
    ) as { kind: number; pubkey: string; tags: string[][] };
    expect(signedDeleteEvent.kind).toBe(27235);
    expect(signedDeleteEvent.pubkey).toBe(session.pubkey);
    expect(signedDeleteEvent.tags).toEqual(
      expect.arrayContaining([
        ["action", "delete_cached_events"],
        ["method", "POST"],
        ["path", "/api/db/delete-events"],
        ["pubkey", session.pubkey],
        ["eventIds", "listing-event"],
      ])
    );
  });

  test("uploads seller listing media through the Blossom helper", async () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );
    const fetchSpy = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "",
        json: async () => ({ success: true }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          url: "https://cdn.nostrcheck.me/image.jpg",
          sha256: "hash",
          size: 4,
          type: "image/jpeg",
        }),
      } as Response);
    global.fetch = fetchSpy as typeof fetch;
    const uploadBody = new Blob(["native-image"], { type: "image/jpeg" });

    const uploaded = await uploadSellerListingMedia({
      baseUrl: "http://127.0.0.1:5000",
      session,
      fileName: "image.jpg",
      mimeType: "image/jpeg",
      bytes: new Uint8Array([1, 2, 3, 4]),
      uploadBody,
    });

    expect(uploaded).toEqual({
      url: "https://cdn.nostrcheck.me/image.jpg",
      sha256: "hash",
      size: 4,
      mimeType: "image/jpeg",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenLastCalledWith(
      "https://cdn.nostrcheck.me/upload",
      expect.objectContaining({
        method: "PUT",
        body: uploadBody,
        headers: expect.objectContaining({
          "X-SHA-256":
            "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
        }),
      })
    );
  });
});
