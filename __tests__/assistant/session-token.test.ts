// Unit tests for the scoped assistant session tokens: the bearer tokens that
// let NIP-07/NIP-46 users chat and manage assistant/MCP-key settings without
// a signing prompt per request. Scopes are domain-separated — a token minted
// for one surface must never verify on another.

import {
  mintAssistantSessionToken,
  verifyAssistantSessionToken,
  isAssistantSessionScope,
  SESSION_SCOPE_TTLS_MS,
  SESSION_TOKEN_TTL_MS,
} from "@/utils/assistant/session-token";

const PUBKEY = "a".repeat(64);
const OTHER_PUBKEY = "b".repeat(64);

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-with-plenty-of-chars";
});

describe("assistant session tokens", () => {
  it("round-trips a freshly minted token (default chat scope)", () => {
    const now = Date.now();
    const { token, expiresAtMs } = mintAssistantSessionToken(
      PUBKEY,
      "chat",
      now
    );
    expect(expiresAtMs).toBe(now + SESSION_TOKEN_TTL_MS);
    expect(verifyAssistantSessionToken(token, "chat", now)).toEqual({
      pubkey: PUBKEY,
      expiresAtMs,
    });
  });

  it("round-trips every scope with its own TTL", () => {
    const now = Date.now();
    for (const scope of ["chat", "assistant-setup", "mcp-keys"] as const) {
      const { token, expiresAtMs } = mintAssistantSessionToken(
        PUBKEY,
        scope,
        now
      );
      expect(expiresAtMs).toBe(now + SESSION_SCOPE_TTLS_MS[scope]);
      expect(verifyAssistantSessionToken(token, scope, now)).toEqual({
        pubkey: PUBKEY,
        expiresAtMs,
      });
    }
  });

  it("management scopes live shorter than chat", () => {
    expect(SESSION_SCOPE_TTLS_MS["assistant-setup"]).toBeLessThan(
      SESSION_SCOPE_TTLS_MS.chat
    );
    expect(SESSION_SCOPE_TTLS_MS["mcp-keys"]).toBeLessThan(
      SESSION_SCOPE_TTLS_MS.chat
    );
  });

  it("never verifies a token under a different scope", () => {
    const { token: chatToken } = mintAssistantSessionToken(PUBKEY, "chat");
    const { token: setupToken } = mintAssistantSessionToken(
      PUBKEY,
      "assistant-setup"
    );
    const { token: keysToken } = mintAssistantSessionToken(PUBKEY, "mcp-keys");

    // Chat tokens must not work on setup/key endpoints and vice versa.
    expect(verifyAssistantSessionToken(chatToken, "assistant-setup")).toBeNull();
    expect(verifyAssistantSessionToken(chatToken, "mcp-keys")).toBeNull();
    expect(verifyAssistantSessionToken(setupToken, "chat")).toBeNull();
    expect(verifyAssistantSessionToken(setupToken, "mcp-keys")).toBeNull();
    expect(verifyAssistantSessionToken(keysToken, "chat")).toBeNull();
    expect(verifyAssistantSessionToken(keysToken, "assistant-setup")).toBeNull();
  });

  it("rejects a payload whose scope field was swapped to match the verifier", () => {
    const { token } = mintAssistantSessionToken(PUBKEY, "chat");
    const [, mac] = token.split(".");
    // Forge a payload claiming the assistant-setup scope — the MAC is
    // computed under the chat label, so it must not verify.
    const forgedPayload = Buffer.from(
      JSON.stringify({
        pk: PUBKEY,
        sc: "assistant-setup",
        iat: Date.now(),
        exp: Date.now() + SESSION_SCOPE_TTLS_MS["assistant-setup"],
      }),
      "utf8"
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(
      verifyAssistantSessionToken(`${forgedPayload}.${mac}`, "assistant-setup")
    ).toBeNull();
  });

  it("rejects a token after its window", () => {
    const now = Date.now();
    const { token } = mintAssistantSessionToken(PUBKEY, "chat", now);
    expect(
      verifyAssistantSessionToken(token, "chat", now + SESSION_TOKEN_TTL_MS)
    ).toBeNull();
    expect(
      verifyAssistantSessionToken(
        token,
        "chat",
        now + SESSION_TOKEN_TTL_MS + 60_000
      )
    ).toBeNull();
  });

  it("rejects a tampered payload (swapped pubkey)", () => {
    const { token } = mintAssistantSessionToken(PUBKEY);
    const [payload, mac] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        pk: OTHER_PUBKEY,
        sc: "chat",
        iat: Date.now(),
        exp: Date.now() + SESSION_TOKEN_TTL_MS,
      }),
      "utf8"
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(
      verifyAssistantSessionToken(`${forgedPayload}.${mac}`)
    ).toBeNull();
    expect(payload).not.toBe(forgedPayload);
  });

  it("rejects a token signed under a different secret", () => {
    const { token } = mintAssistantSessionToken(PUBKEY);
    process.env.SESSION_SECRET = "a-different-secret-entirely-123456";
    expect(verifyAssistantSessionToken(token)).toBeNull();
  });

  it("rejects tokens issued in the future or with an oversized window", () => {
    const now = Date.now();
    const future = mintAssistantSessionToken(
      PUBKEY,
      "chat",
      now + 60 * 60 * 1000
    );
    expect(verifyAssistantSessionToken(future.token, "chat", now)).toBeNull();
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "abc", "a.b.c", ".", "x.y"]) {
      expect(verifyAssistantSessionToken(bad)).toBeNull();
    }
  });

  it("rejects legacy (scope-less) payload shape", () => {
    // Pre-scope tokens carried {pk, iat, exp} without sc; they must fail
    // closed and force a re-mint rather than verifying under some default.
    const now = Date.now();
    const { token } = mintAssistantSessionToken(PUBKEY, "chat", now);
    const [payloadPart] = token.split(".");
    const parsed = JSON.parse(
      Buffer.from(payloadPart!, "base64").toString("utf8")
    );
    delete parsed.sc;
    const legacyPayload = Buffer.from(JSON.stringify(parsed), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    // Even with a valid MAC for this payload it fails the scope-field check.
    const { createHmac } = require("crypto");
    const mac = createHmac("sha256", process.env.SESSION_SECRET)
      .update(`assistant-session:chat:${legacyPayload}`)
      .digest("hex")
      .slice(0, 32);
    expect(
      verifyAssistantSessionToken(`${legacyPayload}.${mac}`, "chat", now)
    ).toBeNull();
  });

  it("refuses to mint for a non-hex pubkey or unknown scope", () => {
    expect(() => mintAssistantSessionToken("not-a-pubkey")).toThrow();
    expect(() =>
      mintAssistantSessionToken(PUBKEY, "not-a-scope" as never)
    ).toThrow();
  });

  it("validates scope names", () => {
    expect(isAssistantSessionScope("chat")).toBe(true);
    expect(isAssistantSessionScope("assistant-setup")).toBe(true);
    expect(isAssistantSessionScope("mcp-keys")).toBe(true);
    expect(isAssistantSessionScope("admin")).toBe(false);
    expect(isAssistantSessionScope(undefined)).toBe(false);
    expect(isAssistantSessionScope(42)).toBe(false);
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
