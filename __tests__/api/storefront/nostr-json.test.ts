const mockQuery = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getDbPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
  fetchCachedEvents: jest.fn(),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));

jest.mock("@/utils/pro/membership", () => ({
  getMembershipView: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { fetchCachedEvents } from "@/utils/db/db-service";
import { getMembershipView } from "@/utils/pro/membership";
import handler from "@/pages/api/storefront/nostr-json";

const mockedFetchCachedEvents = fetchCachedEvents as unknown as jest.Mock;
const mockedGetMembershipView = getMembershipView as unknown as jest.Mock;

const PUBKEY = "a".repeat(64);

type MockApiResponse = NextApiResponse & {
  body: unknown;
  headers: Record<string, string>;
  statusCode: number;
  ended: boolean;
};

const createResponse = () => {
  const response = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined as unknown,
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
  return response as unknown as MockApiResponse;
};

const makeRequest = ({
  query = {},
  headers = {},
  method = "GET",
}: {
  query?: NextApiRequest["query"];
  headers?: Record<string, string>;
  method?: string;
} = {}): NextApiRequest =>
  ({
    method,
    query,
    headers,
  }) as Partial<NextApiRequest> as NextApiRequest;

const mockVerifiedDomain = (pubkey = PUBKEY) => {
  mockQuery.mockResolvedValue({ rows: [{ pubkey }] });
};

const mockProfileName = (name: string) => {
  mockedFetchCachedEvents.mockResolvedValue([
    { pubkey: PUBKEY, content: JSON.stringify({ name }), created_at: 1 },
  ]);
};

describe("/api/storefront/nostr-json", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockedFetchCachedEvents.mockReset();
    mockedGetMembershipView.mockReset();
    mockedGetMembershipView.mockResolvedValue({ isHidden: false });
  });

  it("resolves the seller from the custom-domain host and maps username -> hex pubkey", async () => {
    mockVerifiedDomain();
    mockProfileName("farmstand");
    const res = createResponse();

    await handler(
      makeRequest({ headers: { "x-mm-custom-domain-host": "farm.example" } }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ names: { farmstand: PUBKEY } });
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(res.headers["Cache-Control"]).toBe("no-store, max-age=0");
    // Resolution is by domain, never a supplied pubkey.
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [
      "farm.example",
    ]);
  });

  it("strips a :port suffix from the host before the domain lookup", async () => {
    mockVerifiedDomain();
    mockProfileName("farmstand");
    const res = createResponse();

    await handler(
      makeRequest({
        headers: { "x-mm-custom-domain-host": "farm.example:443" },
      }),
      res
    );

    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), [
      "farm.example",
    ]);
    expect(res.body).toEqual({ names: { farmstand: PUBKEY } });
  });

  it("exposes a lower-cased alias for a mixed-case username", async () => {
    mockVerifiedDomain();
    mockProfileName("Forest Art");
    const res = createResponse();

    await handler(
      makeRequest({ headers: { "x-mm-custom-domain-host": "forest.example" } }),
      res
    );

    expect(res.body).toEqual({
      names: { "Forest Art": PUBKEY, "forest art": PUBKEY },
    });
  });

  it("honors a ?name= filter case-insensitively, echoing the requested casing", async () => {
    mockVerifiedDomain();
    mockProfileName("farmstand");
    const res = createResponse();

    await handler(
      makeRequest({
        query: { name: "FARMSTAND" },
        headers: { "x-mm-custom-domain-host": "farm.example" },
      }),
      res
    );

    expect(res.body).toEqual({ names: { FARMSTAND: PUBKEY } });
  });

  it("returns empty names when ?name= does not match the seller username", async () => {
    mockVerifiedDomain();
    mockProfileName("farmstand");
    const res = createResponse();

    await handler(
      makeRequest({
        query: { name: "someoneelse" },
        headers: { "x-mm-custom-domain-host": "farm.example" },
      }),
      res
    );

    expect(res.body).toEqual({ names: {} });
  });

  it("does NOT resolve a hidden/lapsed seller (membership-gated)", async () => {
    mockVerifiedDomain();
    mockedGetMembershipView.mockResolvedValue({ isHidden: true });
    const res = createResponse();

    await handler(
      makeRequest({ headers: { "x-mm-custom-domain-host": "lapsed.example" } }),
      res
    );

    expect(res.body).toEqual({ names: {} });
    expect(mockedFetchCachedEvents).not.toHaveBeenCalled();
  });

  it("ignores a forged x-mm-shop-pubkey header (no domain => empty names)", async () => {
    const res = createResponse();

    await handler(
      makeRequest({ headers: { "x-mm-shop-pubkey": "f".repeat(64) } }),
      res
    );

    expect(res.body).toEqual({ names: {} });
    // The forgeable pubkey header must never drive a DB/profile lookup.
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockedFetchCachedEvents).not.toHaveBeenCalled();
  });

  it("returns empty names for an unverified/unknown domain", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = createResponse();

    await handler(
      makeRequest({
        headers: { "x-mm-custom-domain-host": "unknown.example" },
      }),
      res
    );

    expect(res.body).toEqual({ names: {} });
  });

  it("returns empty names when the seller profile has no usable name", async () => {
    mockVerifiedDomain();
    mockedFetchCachedEvents.mockResolvedValue([
      { pubkey: PUBKEY, content: "not json", created_at: 1 },
    ]);
    const res = createResponse();

    await handler(
      makeRequest({ headers: { "x-mm-custom-domain-host": "farm.example" } }),
      res
    );

    expect(res.body).toEqual({ names: {} });
  });

  it("answers an OPTIONS preflight with CORS and 204", async () => {
    const res = createResponse();

    await handler(makeRequest({ method: "OPTIONS" }), res);

    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("rejects non-GET methods", async () => {
    const res = createResponse();

    await handler(makeRequest({ method: "POST" }), res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: "Method not allowed" });
  });

  it("falls soft to empty names if resolution throws", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const res = createResponse();

    await handler(
      makeRequest({ headers: { "x-mm-custom-domain-host": "farm.example" } }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ names: {} });
    consoleErrorSpy.mockRestore();
  });
});
