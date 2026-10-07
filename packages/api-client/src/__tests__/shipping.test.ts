import {
  SellerShippingApiError,
  createSellerShippingApiClient,
} from "../index";

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function requestFrom(fetchImpl: jest.Mock) {
  const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
  return { url, init, headers: init.headers as Headers };
}

describe("seller shipping api client", () => {
  test("loads connection status and starts mobile OAuth with NIP-98", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ configured: true, connected: false, accountId: null })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          authorizeUrl:
            "https://goshippo.com/oauth/authorize?state=mobile-token",
        })
      );
    const client = createSellerShippingApiClient({
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.getConnectionStatus({ authorizationHeader: "Nostr status" });
    await client.startOAuth({ authorizationHeader: "Nostr start" });

    expect(fetchImpl.mock.calls[0][0]).toBe("/api/shipping/oauth/status");
    expect(fetchImpl.mock.calls[1][1].body).toBe(
      JSON.stringify({ returnTarget: "mobile" })
    );
  });

  test("loads and saves shipping defaults", async () => {
    const defaults = {
      fromName: "Milk Farm",
      fromCompany: null,
      fromStreet1: "1 Farm Rd",
      fromStreet2: null,
      fromCity: "Austin",
      fromState: "TX",
      fromZip: "78702",
      fromCountry: "US",
      fromPhone: null,
      fromEmail: null,
      preferredCarriers: ["USPS"],
      autoPurchaseLabels: false,
    };
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, defaults }))
      .mockResolvedValueOnce(jsonResponse({ success: true, defaults }));
    const client = createSellerShippingApiClient({
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.getDefaults({ authorizationHeader: "Nostr get" })
    ).resolves.toEqual(defaults);
    await client.saveDefaults({
      body: defaults,
      authorizationHeader: "Nostr save",
    });

    expect(fetchImpl.mock.calls[1][1].body).toBe(JSON.stringify(defaults));
  });

  test("loads labels for one order with NIP-98 authorization", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        labels: [
          {
            id: 42,
            shipmentId: "ship-1",
            orderId: "order-1",
            trackingCode: "TRACK-1",
            trackingUrl: "https://carrier.example/track/1",
            labelUrl: "https://labels.example/1.pdf",
            labelFormat: "PDF",
            rateUsd: 8.25,
            currency: "USD",
            carrier: "USPS",
            service: "Priority",
            isReturn: false,
            fromSummary: null,
            toSummary: null,
            parcelSummary: null,
            purchasedAt: "2026-09-03T12:00:00.000Z",
          },
        ],
      })
    );
    const client = createSellerShippingApiClient({
      baseUrl: "http://127.0.0.1:5000/",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.listLabels({
        orderId: "order-1",
        authorizationHeader: "Nostr proof",
      })
    ).resolves.toHaveLength(1);

    const request = requestFrom(fetchImpl);
    expect(request.url).toBe(
      "http://127.0.0.1:5000/api/shipping/labels?orderId=order-1"
    );
    expect(request.init.method).toBe("GET");
    expect(request.headers.get("Authorization")).toBe("Nostr proof");
  });

  test("quotes a trusted order with an exactly serialized body", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        shipmentId: "ship-1",
        rates: [
          {
            id: "rate-1",
            shipmentId: "ship-1",
            carrier: "USPS",
            service: "Priority",
            rate: 8.25,
            currency: "USD",
            deliveryDays: 2,
          },
        ],
      })
    );
    const client = createSellerShippingApiClient({
      fetchImpl: fetchImpl as typeof fetch,
    });
    const body = {
      orderId: "order-1",
      to: {
        name: "Ada",
        street1: "12 Market St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
      parcel: { weightOz: 16 },
    };

    await client.quoteOrder({
      body,
      authorizationHeader: "Nostr quote-proof",
    });

    const request = requestFrom(fetchImpl);
    expect(request.url).toBe("/api/shipping/rates");
    expect(request.init.method).toBe("POST");
    expect(request.init.body).toBe(JSON.stringify(body));
    expect(request.headers.get("Authorization")).toBe("Nostr quote-proof");
  });

  test("authorizes the exact normalized request body sent over HTTP", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ success: true, shipmentId: "ship-1", rates: [] })
      );
    const client = createSellerShippingApiClient({
      fetchImpl: fetchImpl as typeof fetch,
    });
    const signedBodies: Array<string | undefined> = [];

    await client.quoteOrder({
      body: {
        orderId: " order-1 ",
        to: {
          street1: "12 Market St",
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          country: "US",
        },
        parcel: { weightOz: 16 },
      },
      authorize: ({ body }) => {
        signedBodies.push(body);
        return "Nostr exact-body-proof";
      },
    });

    const request = requestFrom(fetchImpl);
    expect(signedBodies).toEqual([request.init.body]);
    expect(request.init.body).toBe(
      JSON.stringify({
        orderId: "order-1",
        to: {
          street1: "12 Market St",
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          country: "US",
        },
        parcel: { weightOz: 16 },
      })
    );
    expect(request.headers.get("Authorization")).toBe("Nostr exact-body-proof");
  });

  test("purchases one order-bound label", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        id: 42,
        shipmentId: "ship-1",
        trackingCode: "TRACK-1",
        trackingUrl: null,
        labelUrl: "https://labels.example/1.pdf",
        labelFormat: "PDF",
        rate: 8.25,
        currency: "USD",
        carrier: "USPS",
        service: "Priority",
      })
    );
    const client = createSellerShippingApiClient({
      fetchImpl: fetchImpl as typeof fetch,
    });
    const body = {
      orderId: "order-1",
      shipmentId: "ship-1",
      rateId: "rate-1",
    };

    await expect(
      client.buyOrderLabel({
        body,
        authorizationHeader: "Nostr buy-proof",
      })
    ).resolves.toMatchObject({ id: 42, trackingCode: "TRACK-1" });

    const request = requestFrom(fetchImpl);
    expect(request.url).toBe("/api/shipping/buy-label");
    expect(request.init.body).toBe(JSON.stringify(body));
  });

  test("rejects malformed success responses", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse({ success: true, labels: "bad" }));
    const client = createSellerShippingApiClient({
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.listLabels({ authorizationHeader: "Nostr proof" })
    ).rejects.toMatchObject({
      name: "SellerShippingApiError",
      code: "INVALID_RESPONSE",
    });
  });

  test("keeps conflict status for duplicate-purchase handling", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "Label already purchased" }, 409)
      );
    const client = createSellerShippingApiClient({
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.buyOrderLabel({
        body: {
          orderId: "order-1",
          shipmentId: "ship-1",
          rateId: "rate-1",
        },
        authorizationHeader: "Nostr proof",
      })
    ).rejects.toEqual(
      expect.objectContaining({
        status: 409,
        code: "REQUEST_FAILED",
      } satisfies Partial<SellerShippingApiError>)
    );
  });
});
