jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
}));

const mockIsPubkeyProEntitled = jest.fn();
jest.mock("@/utils/pro/membership", () => ({
  isPubkeyProEntitled: (...args: any[]) => mockIsPubkeyProEntitled(...args),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import {
  authenticateRequest,
  canUsePurchaseTools,
  canUseSellerReadTools,
  canUseSellerWriteTools,
  deactivateApiKeysForPubkey,
  extractBearerToken,
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  ApiKeyRecord,
  MCP_PRO_REQUIRED_MESSAGE,
} from "@/utils/mcp/auth";
import { getDbPool } from "@/utils/db/db-service";

const FIXED_NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

describe("MCP auth helpers", () => {
  let dateNowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(FIXED_NOW_MS);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  describe("generateApiKey", () => {
    it("returns an mm_-prefixed key and matching prefix", () => {
      const { key, prefix } = generateApiKey();

      expect(key.startsWith("ss_")).toBe(true);
      expect(prefix).toHaveLength(10);
      expect(prefix).toBe(key.substring(0, 10));
    });
  });

  describe("hashApiKey and verifyApiKey", () => {
    it("verifies the original key against its generated hash", () => {
      const { key } = generateApiKey();
      const keyHash = hashApiKey(key);

      expect(keyHash.startsWith("pbkdf2_sha256$100000$")).toBe(true);
      expect(verifyApiKey(key, keyHash)).toBe(true);
    });

    it("rejects a different key", () => {
      const { key } = generateApiKey();
      const otherKey = generateApiKey().key;

      expect(verifyApiKey(otherKey, hashApiKey(key))).toBe(false);
    });

    it("rejects malformed stored hashes", () => {
      const { key } = generateApiKey();

      expect(verifyApiKey(key, "bad-hash")).toBe(false);
    });
  });

  describe("extractBearerToken", () => {
    it("returns the bearer token when the header is well-formed", () => {
      const req = {
        headers: {
          authorization: "Bearer sk_test_token",
        },
      } as NextApiRequest;

      expect(extractBearerToken(req)).toBe("sk_test_token");
    });

    it("returns null when the authorization header is missing", () => {
      const req = {
        headers: {},
      } as NextApiRequest;

      expect(extractBearerToken(req)).toBeNull();
    });

    it("returns null when the authorization header is not a bearer token", () => {
      const req = {
        headers: {
          authorization: "Basic abc123",
        },
      } as NextApiRequest;

      expect(extractBearerToken(req)).toBeNull();
    });
  });
});

describe("audience helpers", () => {
  const makeKey = (
    audience: "shopping" | "seller",
    permissions: "read" | "read_write" | "full_access"
  ) =>
    ({
      audience,
      permissions,
    }) as ApiKeyRecord;

  it("shopping keys reach purchase tooling at the stored read tier", () => {
    const key = makeKey("shopping", "read");
    expect(canUsePurchaseTools(key)).toBe(true);
    expect(canUseSellerReadTools(key)).toBe(false);
    expect(canUseSellerWriteTools(key)).toBe(false);
  });

  it("seller keys keep their legacy permission tier", () => {
    expect(canUsePurchaseTools(makeKey("seller", "read"))).toBe(false);
    expect(canUsePurchaseTools(makeKey("seller", "read_write"))).toBe(true);
    expect(canUseSellerWriteTools(makeKey("seller", "read_write"))).toBe(false);
    expect(canUseSellerWriteTools(makeKey("seller", "full_access"))).toBe(true);
  });

  it("a shopping key with a full_access tier still cannot use seller tools", () => {
    // Defense in depth: even if a shopping row somehow carries full_access,
    // the audience gate (not the tier) decides seller-tool access.
    const key = makeKey("shopping", "full_access");
    expect(canUseSellerReadTools(key)).toBe(false);
    expect(canUseSellerWriteTools(key)).toBe(false);
  });
});

describe("authenticateRequest audience gating", () => {
  const mockClient = { query: jest.fn(), release: jest.fn() };

  function makeRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
    } as unknown as NextApiResponse & {
      status: jest.Mock;
      json: jest.Mock;
      setHeader: jest.Mock;
    };
  }

  async function makeKeyAndRecord(
    audience: "shopping" | "seller",
    permissions: "read" | "read_write" | "full_access"
  ) {
    const { key, prefix } = generateApiKey();
    const record: ApiKeyRecord = {
      id: 1,
      key_prefix: prefix,
      key_hash: hashApiKey(key),
      name: "test",
      pubkey: "a".repeat(64),
      permissions,
      audience,
      created_at: "",
      last_used_at: null,
      is_active: true,
    };
    return { key, record };
  }

  function mockPoolFor(record: ApiKeyRecord) {
    mockClient.query
      .mockResolvedValueOnce({ rows: [record] }) // validateApiKey SELECT
      .mockResolvedValueOnce({ rowCount: 1 }); // last_used_at UPDATE
    (getDbPool as jest.Mock).mockReturnValue({
      connect: async () => mockClient,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("lets a shopping key through without any Pro entitlement check", async () => {
    const { key, record } = await makeKeyAndRecord("shopping", "read");
    mockPoolFor(record);
    mockIsPubkeyProEntitled.mockResolvedValue(false);

    const req = {
      headers: { authorization: `Bearer ${key}`, host: "localhost" },
    } as unknown as NextApiRequest;
    const res = makeRes();

    const out = await authenticateRequest(req, res, "read_write");

    expect(out?.id).toBe(1);
    // The whole point of the shopping audience: no membership lookup at all.
    expect(mockIsPubkeyProEntitled).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it("rejects a seller key whose owner is not Pro-entitled", async () => {
    const { key, record } = await makeKeyAndRecord("seller", "full_access");
    mockPoolFor(record);
    mockIsPubkeyProEntitled.mockResolvedValue(false);

    const req = {
      headers: { authorization: `Bearer ${key}`, host: "localhost" },
    } as unknown as NextApiRequest;
    const res = makeRes();

    const out = await authenticateRequest(req, res);

    expect(out).toBeNull();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: MCP_PRO_REQUIRED_MESSAGE })
    );
  });

  it("keeps a legacy read-tier seller key out of purchase routes", async () => {
    const { key, record } = await makeKeyAndRecord("seller", "read");
    mockPoolFor(record);
    mockIsPubkeyProEntitled.mockResolvedValue(true);

    const req = {
      headers: { authorization: `Bearer ${key}`, host: "localhost" },
    } as unknown as NextApiRequest;
    const res = makeRes();

    const out = await authenticateRequest(req, res, "read_write");

    expect(out).toBeNull();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("blocks a shopping key from full_access-required routes", async () => {
    const { key, record } = await makeKeyAndRecord("shopping", "read");
    mockPoolFor(record);

    const req = {
      headers: { authorization: `Bearer ${key}`, host: "localhost" },
    } as unknown as NextApiRequest;
    const res = makeRes();

    const out = await authenticateRequest(req, res, "full_access");

    expect(out).toBeNull();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("deactivateApiKeysForPubkey audience scoping", () => {
  it("only deactivates seller keys so shopping keys survive a lapse", async () => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rowCount: 1 }),
      release: jest.fn(),
    };
    (getDbPool as jest.Mock).mockReturnValue({
      connect: async () => mockClient,
    });

    const count = await deactivateApiKeysForPubkey("b".repeat(64));

    expect(count).toBe(1);
    const [sql] = mockClient.query.mock.calls[0]!;
    expect(sql).toContain("audience = 'seller'");
    expect(mockClient.release).toHaveBeenCalled();
  });
});
