// Unit tests for the assistant chat session token: the bearer token that lets
// NIP-07/NIP-46 users chat without a signing prompt per message.

import {
  mintAssistantSessionToken,
  verifyAssistantSessionToken,
  SESSION_TOKEN_TTL_MS,
} from "@/utils/assistant/session-token";

const PUBKEY = "a".repeat(64);
const OTHER_PUBKEY = "b".repeat(64);

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-with-plenty-of-chars";
});

describe("assistant session tokens", () => {
  it("round-trips a freshly minted token", () => {
    const now = Date.now();
    const { token, expiresAtMs } = mintAssistantSessionToken(PUBKEY, now);
    expect(expiresAtMs).toBe(now + SESSION_TOKEN_TTL_MS);
    expect(verifyAssistantSessionToken(token, now)).toEqual({
      pubkey: PUBKEY,
      expiresAtMs,
    });
  });

  it("rejects a token after its window", () => {
    const now = Date.now();
    const { token } = mintAssistantSessionToken(PUBKEY, now);
    expect(
      verifyAssistantSessionToken(token, now + SESSION_TOKEN_TTL_MS)
    ).toBeNull();
    expect(
      verifyAssistantSessionToken(token, now + SESSION_TOKEN_TTL_MS + 60_000)
    ).toBeNull();
  });

  it("rejects a tampered payload (swapped pubkey)", () => {
    const { token } = mintAssistantSessionToken(PUBKEY);
    const [payload, mac] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        pk: OTHER_PUBKEY,
        iat: Date.now(),
        exp: Date.now() + SESSION_TOKEN_TTL_MS,
      }),
      "utf8"
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifyAssistantSessionToken(`${forgedPayload}.${mac}`)).toBeNull();
    expect(payload).not.toBe(forgedPayload);
  });

  it("rejects a token signed under a different secret", () => {
    const { token } = mintAssistantSessionToken(PUBKEY);
    process.env.SESSION_SECRET = "a-different-secret-entirely-123456";
    expect(verifyAssistantSessionToken(token)).toBeNull();
  });

  it("rejects tokens issued in the future or with an oversized window", () => {
    const now = Date.now();
    const future = mintAssistantSessionToken(PUBKEY, now + 60 * 60 * 1000);
    expect(verifyAssistantSessionToken(future.token, now)).toBeNull();
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "abc", "a.b.c", ".", "x.y"]) {
      expect(verifyAssistantSessionToken(bad)).toBeNull();
    }
  });

  it("refuses to mint for a non-hex pubkey", () => {
    expect(() => mintAssistantSessionToken("not-a-pubkey")).toThrow();
  });

  it("fails closed (never forges) when SESSION_SECRET is unset", () => {
    delete process.env.SESSION_SECRET;
    const { token } = (() => {
      process.env.SESSION_SECRET = "temp-secret-for-minting-123456";
      const minted = mintAssistantSessionToken(PUBKEY);
      delete process.env.SESSION_SECRET;
      return minted;
    })();
    expect(verifyAssistantSessionToken(token)).toBeNull();
    expect(() => mintAssistantSessionToken(PUBKEY)).toThrow();
  });
});
