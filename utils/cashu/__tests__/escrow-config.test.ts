import {
  getAllowedEscrowMints,
  getEscrowArbiterPubkeys,
  isEscrowConfigured,
  isEscrowEnabled,
  isEscrowClientEnabled,
  normalizeEscrowMintUrl,
  ESCROW_ENABLED_ENV,
  ESCROW_ALLOWED_MINTS_ENV,
  ESCROW_ARBITER_PUBKEYS_ENV,
} from "@/utils/cashu/escrow-config";

const VALID_PK_A = "a".repeat(64);
const VALID_PK_B = "B".repeat(64);

describe("escrow-config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env[ESCROW_ENABLED_ENV];
    delete process.env[ESCROW_ALLOWED_MINTS_ENV];
    delete process.env[ESCROW_ARBITER_PUBKEYS_ENV];
    delete process.env.NEXT_PUBLIC_CASHU_ESCROW_ENABLED;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("normalizeEscrowMintUrl", () => {
    it("accepts https URLs and strips trailing slashes", () => {
      expect(normalizeEscrowMintUrl("https://mint.example/")).toBe(
        "https://mint.example"
      );
      expect(normalizeEscrowMintUrl("https://mint.example///")).toBe(
        "https://mint.example"
      );
    });

    it("rejects non-URL and non-http(s) values", () => {
      expect(normalizeEscrowMintUrl("not a url")).toBeNull();
      expect(normalizeEscrowMintUrl("ftp://mint.example")).toBeNull();
      expect(normalizeEscrowMintUrl("")).toBeNull();
    });

    it("rejects plain http except for loopback dev mints", () => {
      expect(normalizeEscrowMintUrl("http://mint.example")).toBeNull();
      expect(normalizeEscrowMintUrl("http://192.168.1.10:3338")).toBeNull();
      expect(normalizeEscrowMintUrl("http://localhost:3338")).toBe(
        "http://localhost:3338"
      );
      expect(normalizeEscrowMintUrl("http://127.0.0.1:3338")).toBe(
        "http://127.0.0.1:3338"
      );
    });
  });

  describe("getAllowedEscrowMints", () => {
    it("is empty when unset (fail closed)", () => {
      expect(getAllowedEscrowMints().size).toBe(0);
    });

    it("parses, normalizes, and dedupes a comma-separated list", () => {
      const mints = getAllowedEscrowMints(
        " https://mint-a.example/ , https://mint-b.example, https://mint-a.example, junk"
      );
      expect(Array.from(mints).sort()).toEqual([
        "https://mint-a.example",
        "https://mint-b.example",
      ]);
    });
  });

  describe("getEscrowArbiterPubkeys", () => {
    it("is empty when unset (fail closed)", () => {
      expect(getEscrowArbiterPubkeys().size).toBe(0);
    });

    it("keeps valid 64-hex pubkeys (lowercased) and drops invalid entries", () => {
      const arbiters = getEscrowArbiterPubkeys(
        `${VALID_PK_A.toUpperCase()}, ${VALID_PK_B.toLowerCase()}, not-a-pubkey, ${"z".repeat(64)}`
      );
      expect(Array.from(arbiters).sort()).toEqual([
        VALID_PK_A,
        VALID_PK_B.toLowerCase(),
      ]);
    });
  });

  describe("isEscrowConfigured / isEscrowEnabled", () => {
    it("fails closed with nothing configured", () => {
      expect(isEscrowConfigured()).toBe(false);
      expect(isEscrowEnabled()).toBe(false);
    });

    it("requires BOTH mints and arbiters", () => {
      process.env[ESCROW_ALLOWED_MINTS_ENV] = "https://mint-a.example";
      expect(isEscrowConfigured()).toBe(false);
      process.env[ESCROW_ARBITER_PUBKEYS_ENV] = VALID_PK_A;
      expect(isEscrowConfigured()).toBe(true);
    });

    it("requires the explicit enable flag in addition to configuration", () => {
      process.env[ESCROW_ALLOWED_MINTS_ENV] = "https://mint-a.example";
      process.env[ESCROW_ARBITER_PUBKEYS_ENV] = VALID_PK_A;
      expect(isEscrowEnabled()).toBe(false);
      process.env[ESCROW_ENABLED_ENV] = "yes";
      expect(isEscrowEnabled()).toBe(false);
      process.env[ESCROW_ENABLED_ENV] = "true";
      expect(isEscrowEnabled()).toBe(true);
    });
  });

  describe("isEscrowClientEnabled", () => {
    it("only honors the exact string 'true'", () => {
      expect(isEscrowClientEnabled()).toBe(false);
      process.env.NEXT_PUBLIC_CASHU_ESCROW_ENABLED = "1";
      expect(isEscrowClientEnabled()).toBe(false);
      process.env.NEXT_PUBLIC_CASHU_ESCROW_ENABLED = "true";
      expect(isEscrowClientEnabled()).toBe(true);
    });
  });
});
