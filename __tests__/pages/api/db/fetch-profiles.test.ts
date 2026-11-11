jest.mock("@/utils/db/db-service", () => ({
  fetchAllProfilesFromDb: jest.fn(),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => Promise.resolve(true)),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import handler, {
  MAX_FILTER_PUBKEYS,
} from "@/pages/api/db/fetch-profiles";
import { fetchAllProfilesFromDb } from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";

const mockedFetchAllProfilesFromDb =
  fetchAllProfilesFromDb as jest.MockedFunction<
    typeof fetchAllProfilesFromDb
  >;
const mockedApplyRateLimit = applyRateLimit as jest.MockedFunction<
  typeof applyRateLimit
>;

type MockApiResponse = NextApiResponse & {
  body: unknown;
  statusCode: number;
};

const createResponse = () => {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };

  return response as unknown as MockApiResponse;
};

const makeRequest = (
  query: NextApiRequest["query"],
  method = "GET"
): NextApiRequest =>
  ({
    method,
    query,
  }) as Partial<NextApiRequest> as NextApiRequest;

const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = "b".repeat(64);

describe("pages/api/db/fetch-profiles", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedApplyRateLimit.mockResolvedValue(true);
    mockedFetchAllProfilesFromDb.mockResolvedValue([]);
  });

  it("rejects non-GET methods", async () => {
    const res = createResponse();
    await handler(makeRequest({}, "POST"), res);
    expect(res.statusCode).toBe(405);
    expect(mockedFetchAllProfilesFromDb).not.toHaveBeenCalled();
  });

  it("does not query the database when rate limited", async () => {
    mockedApplyRateLimit.mockResolvedValue(false);
    const res = createResponse();
    await handler(makeRequest({}), res);
    expect(mockedFetchAllProfilesFromDb).not.toHaveBeenCalled();
  });

  it("returns the full (unfiltered) profile set when no filter is given", async () => {
    const profiles = [{ id: "1", pubkey: PUBKEY_A, kind: 0 }];
    mockedFetchAllProfilesFromDb.mockResolvedValue(profiles as any);

    const res = createResponse();
    await handler(makeRequest({}), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(profiles);
    expect(mockedFetchAllProfilesFromDb).toHaveBeenCalledWith({
      pubkeys: undefined,
      kinds: undefined,
    });
  });

  it("passes pubkeys and kinds down so filtering happens in SQL", async () => {
    const res = createResponse();
    await handler(
      makeRequest({ pubkeys: `${PUBKEY_A},${PUBKEY_B}`, kinds: "0,30019" }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(mockedFetchAllProfilesFromDb).toHaveBeenCalledWith({
      pubkeys: [PUBKEY_A, PUBKEY_B],
      kinds: [0, 30019],
    });
  });

  it.each([
    ["a non-hex pubkey", { pubkeys: "not-a-pubkey" }],
    ["an uppercase pubkey", { pubkeys: "A".repeat(64) }],
    ["a short pubkey", { pubkeys: "abc123" }],
    ["a non-numeric kind", { kinds: "zero" }],
    ["a kind outside the table CHECK constraint", { kinds: "30402" }],
    ["a blank kind segment", { kinds: "0," }],
    ["a repeated-parameter array", { pubkeys: [PUBKEY_A, PUBKEY_B] }],
  ])("returns 400 for %s", async (_label, query) => {
    const res = createResponse();
    await handler(makeRequest(query), res);
    expect(res.statusCode).toBe(400);
    expect(mockedFetchAllProfilesFromDb).not.toHaveBeenCalled();
  });

  it("returns 400 when the pubkey filter exceeds the cap", async () => {
    const res = createResponse();
    await handler(
      makeRequest({
        pubkeys: Array.from({ length: MAX_FILTER_PUBKEYS + 1 }, (_, i) =>
          i.toString(16).padStart(64, "0")
        ).join(","),
      }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(mockedFetchAllProfilesFromDb).not.toHaveBeenCalled();
  });

  it("accepts exactly the capped number of pubkeys", async () => {
    const res = createResponse();
    await handler(
      makeRequest({
        pubkeys: Array.from({ length: MAX_FILTER_PUBKEYS }, (_, i) =>
          i.toString(16).padStart(64, "0")
        ).join(","),
      }),
      res
    );
    expect(res.statusCode).toBe(200);
  });

  it("returns 500 when the database read fails", async () => {
    mockedFetchAllProfilesFromDb.mockRejectedValue(new Error("db down"));
    const res = createResponse();
    await handler(makeRequest({}), res);
    expect(res.statusCode).toBe(500);
  });
});
