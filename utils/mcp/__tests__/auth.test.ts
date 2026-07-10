jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
}));

import type { NextApiRequest } from "next";
import {
  extractBearerToken,
  generateApiKey,
  hashApiKey,
  verifyApiKey,
} from "@/utils/mcp/auth";

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

      expect(key.startsWith("mm_")).toBe(true);
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
