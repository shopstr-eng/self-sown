/**
 * Guard: no hardcoded relay URL literals in app source.
 *
 * Why: DEFAULT_SELLER_RELAYS (packages/domain/src/seller.ts, surfaced as
 * getDefaultRelays()) is the single source of default relays. Every time a
 * component copies a literal list back in (product-card.tsx and
 * ZapsnagButton.tsx both did), the default silently forks and relay-set
 * changes stop reaching that surface. This test fails CI before a new
 * literal can be merged.
 *
 * Pure fs/regex scan: no app imports, no relay connections.
 *
 * The Expo mobile app (apps/mobile) is scanned too: it has no Jest config of
 * its own, but this guard is a pure fs scan from the repo root, so extending
 * SCAN_DIRS covers it with no mobile test setup.
 *
 * Tolerated uses:
 * - Test files and __tests__ dirs (fixtures need concrete URLs).
 * - packages/domain/src/seller.ts (the definition itself) — outside SCAN_DIRS.
 * - BLASTR_RELAY — also defined in the domain package.
 * - utils/nostr/nip65-indexer-fetch.ts: its well-known indexer list must
 *   stay a subset of DEFAULT_SELLER_RELAYS, enforced by
 *   utils/nostr/__tests__/nip65-indexer-fetch.test.ts.
 */
import fs from "fs";
import path from "path";

const REPO_ROOT = process.cwd();
const SCAN_DIRS = ["components", "pages", "utils", "mcp", "apps/mobile"];
const ALLOWLIST = new Set([
  path.join(REPO_ROOT, "utils", "nostr", "nip65-indexer-fetch.ts"),
]);
// A relay URL literal: wss:// followed by a real hostname. Placeholders like
// "wss://..." have no host character after the scheme and do not match.
const RELAY_URL_RE = /wss:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/gi;

function collectSourceFiles(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...collectSourceFiles(path.relative(REPO_ROOT, full)));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("no hardcoded relay URL literals", () => {
  it("app source uses getDefaultRelays()/DEFAULT_SELLER_RELAYS, not wss:// literals", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of collectSourceFiles(dir)) {
        if (ALLOWLIST.has(file)) continue;
        const source = fs.readFileSync(file, "utf8");
        const matches = source.match(RELAY_URL_RE);
        if (matches && matches.length > 0) {
          offenders.push(
            `${path.relative(REPO_ROOT, file)}: ${[...new Set(matches)].join(", ")}`
          );
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `Hardcoded relay URL literals fork the default relay set. Import DEFAULT_SELLER_RELAYS from @milk-market/domain (or getDefaultRelays() from utils/nostr/nostr-helper-functions) instead. If the literal is genuinely required, add the file to ALLOWLIST in __tests__/utils/nostr/no-hardcoded-relay-urls.test.ts with a comment justifying it. Offenders:\n${offenders.join("\n")}`
      );
    }
    expect(offenders).toEqual([]);
  });
});
