// Guardrail tests for the shared assistant session-scope constants.
//
// SESSION_SCOPES (utils/assistant/session-scopes.ts) is the ONE place scope
// strings live, shared by browser pages (which mint tokens) and server
// endpoints (which verify them). A typo in a scope string — or an inline
// literal re-introduced on a client surface — silently mints tokens no
// endpoint accepts: the settings pages quietly fall back to per-request
// signing (or fail) with no error pointing at the cause. These tests pin the
// exact scope strings the server verifies against, require a TTL entry for
// every scope, and fail if a client surface passes a string literal to
// mintScopedSessionToken instead of a SESSION_SCOPES constant.

import * as fs from "fs";
import * as path from "path";
import { SESSION_SCOPES } from "@/utils/assistant/session-scopes";
import { SESSION_SCOPE_TTLS_MS } from "@/utils/assistant/session-token";

// The exact scope strings the server endpoints verify against. Mint and
// verify both derive from SESSION_SCOPES, so this literal list is the tripwire
// for an accidental edit of the values themselves.
const EXPECTED_SCOPE_STRINGS = ["chat", "assistant-setup", "mcp-keys"];

describe("assistant session scope constants", () => {
  it("pins the exact scope strings the server verifies", () => {
    expect(Object.values(SESSION_SCOPES).sort()).toEqual(
      [...EXPECTED_SCOPE_STRINGS].sort()
    );
  });

  it("has a TTL entry for every scope in SESSION_SCOPES (and no extras)", () => {
    for (const scope of Object.values(SESSION_SCOPES)) {
      expect(SESSION_SCOPE_TTLS_MS[scope]).toEqual(expect.any(Number));
      expect(SESSION_SCOPE_TTLS_MS[scope]).toBeGreaterThan(0);
    }
    expect(Object.keys(SESSION_SCOPE_TTLS_MS).sort()).toEqual(
      Object.values(SESSION_SCOPES).sort()
    );
  });
});

describe("client surfaces never pass a scope string literal", () => {
  const CLIENT_DIRS = ["pages/settings", "components/assistant"];
  const repoRoot = path.resolve(__dirname, "../..");

  function clientSources(): { file: string; content: string }[] {
    const out: { file: string; content: string }[] = [];
    for (const dir of CLIENT_DIRS) {
      const abs = path.join(repoRoot, dir);
      if (!fs.existsSync(abs)) continue;
      for (const entry of fs.readdirSync(abs)) {
        if (!/\.tsx?$/.test(entry)) continue;
        const file = path.join(dir, entry);
        out.push({
          file,
          content: fs.readFileSync(path.join(abs, entry), "utf8"),
        });
      }
    }
    return out;
  }

  it("every mintScopedSessionToken call uses a SESSION_SCOPES constant", () => {
    const offenders: string[] = [];
    for (const { file, content } of clientSources()) {
      // Grab each call's argument span (calls are short; 300 chars is ample).
      const calls =
        content.match(/mintScopedSessionToken\([\s\S]{0,300}?\)/g) ?? [];
      for (const call of calls) {
        expect(call).toMatch(/SESSION_SCOPES\./);
        for (const scope of Object.values(SESSION_SCOPES)) {
          if (new RegExp(`["'\`]${scope}["'\`]`).test(call)) {
            offenders.push(`${file}: inline literal "${scope}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
