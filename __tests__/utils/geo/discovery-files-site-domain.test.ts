/** @jest-environment node */

// Companion to discovery-files-no-pricing.test.ts / discovery-files-no-claims.test.ts.
//
// The static discovery files under public/ hardcode the site origin in absolute
// URLs (homepage links, API endpoints, .well-known pointers, sitemap). They are
// swapped by hand at a domain cutover (the milk.market → self-sown.com cutover
// used sed), and the other discovery tests only check CONTENT claims — nothing
// cross-checked the advertised domain against the configured site URL. A future
// cutover that misses a file, or a partial edit, would silently ship discovery
// files pointing agents and crawlers at the wrong origin.
//
// Policy enforced here for every absolute http(s) URL in each discovery file:
//
//   1. URLs on the configured site host (resolveExpectedHost()) are correct.
//   2. URLs on LEGACY_SITE_HOST are allowed ONLY as historical references —
//      an operational endpoint path (/api/*, /.well-known/*) on the legacy
//      host is stale cutover drift and fails: legacy page URLs still resolve
//      (the old domain is served as platform traffic), but a legacy API
//      endpoint advertised to agents rots the moment the domain is dropped.
//   3. URLs on EXTERNAL_HOST_ALLOWLIST are legitimate external references.
//   4. ANY other host fails as an unrecognized origin: it is either a stale
//      site domain from a partial cutover, a typo'd domain, or a new external
//      link that must be explicitly allowlisted. This "default-deny" is what
//      makes the guard flip cleanly when NEXT_PUBLIC_BASE_URL changes: the
//      old site domain becomes unrecognized the moment the configured host
//      moves, with no domain hardcoded anywhere in this test.
//
// Additionally every discovery file must reference its own configured origin
// at least once, so a wholesale wrong-domain sed cannot pass.

import { readFileSync } from "fs";
import { join } from "path";
import { getSiteHost } from "@/utils/site-url";

// The retired pre-cutover base domain. No longer exported from
// utils/site-url.ts (the proxy 301 scaffolding was removed once legacy
// traffic faded); kept here as explicit test policy so a stale operational
// endpoint on the old domain is still flagged as drift.
const LEGACY_SITE_HOST = "milk.market";

// --- Static discovery surfaces that hardcode the site origin -----------------

const DISCOVERY_FILES = [
  "public/llms.txt",
  "public/llms-full.txt",
  "public/agents.txt",
  "public/skill.md",
  "public/robots.txt",
  "public/humans.txt",
  "public/.well-known/mcp.json",
  "public/.well-known/agent-card.json",
  "public/.well-known/l402.json",
  "public/.well-known/security.txt",
];

// --- Explicit external-reference policy --------------------------------------
//
// The ONLY non-site hosts allowed in discovery files. Adding a legitimate
// external link to a discovery file requires adding its host here — that is
// intentional: it keeps "host we don't recognize" synonymous with "possible
// stale site domain". Exact host matches only (list the www. form separately).

const EXTERNAL_HOST_ALLOWLIST = new Set([
  "github.com", // source repository
  "njump.me", // Nostr profile links
  "x.com", // social profile
  "modelcontextprotocol.io", // MCP schema reference (mcp.json $schema)
  "docs.lightning.engineering", // L402 protocol documentation
  "www.rfc-editor.org", // RFC 9116 reference (security.txt)
]);

// Paths that must never be advertised on the legacy host: operational
// endpoints advertised to agents must point at the configured origin
// directly, not at the retired domain.
const OPERATIONAL_PATH_RE = /^\/(api|\.well-known)(\/|$)/;

// Absolute URLs only. Excludes quotes/brackets/backticks so JSON and markdown
// prose parse cleanly; trailing sentence punctuation is stripped before
// parsing.
const ABSOLUTE_URL_RE = /https?:\/\/[^\s"'<>)\]`]+/g;

interface ExtractedUrl {
  raw: string;
  host: string;
  pathname: string;
}

function extractUrls(contents: string): ExtractedUrl[] {
  const urls: ExtractedUrl[] = [];
  for (const match of contents.matchAll(ABSOLUTE_URL_RE)) {
    const raw = match[0].replace(/[.,;:]+$/, "");
    try {
      const parsed = new URL(raw);
      urls.push({
        raw,
        host: parsed.hostname.toLowerCase(),
        pathname: parsed.pathname,
      });
    } catch {
      // Not a parseable URL after extraction — not an absolute site URL.
    }
  }
  return urls;
}

function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice("www.".length) : host;
}

function hostMatches(host: string, siteHost: string): boolean {
  return host === siteHost || host.endsWith(`.${siteHost}`);
}

/**
 * Hosts that mean "this checkout's dev preview", where NEXT_PUBLIC_BASE_URL
 * legitimately points at a development origin while the static discovery
 * files still advertise the production domain. Recognized EXPLICITLY so the
 * override is visible policy, not a silent env deletion.
 */
function isDevelopmentHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".replit.dev") ||
    host.endsWith(".repl.co")
  );
}

/** The built-in production fallback host from utils/site-url.ts (env unset). */
function productionFallbackHost(): string {
  const original = process.env.NEXT_PUBLIC_BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  try {
    return getSiteHost();
  } finally {
    if (original !== undefined) process.env.NEXT_PUBLIC_BASE_URL = original;
  }
}

/**
 * The host the discovery files must advertise. Validates the CONFIGURED
 * domain: a non-development NEXT_PUBLIC_BASE_URL (including at a cutover) is
 * used as-is, so a mismatch with the files fails the suite. Two configurations
 * are explicitly overridden to the module's production fallback, because the
 * static files are build artifacts that always advertise the canonical
 * production origin:
 *
 *   - Development origins (localhost, *.replit.dev, …): a dev checkout's env
 *     points at the dev preview, not at what the files must advertise.
 *   - The LEGACY_SITE_HOST itself: a checkout whose env still points at the
 *     pre-cutover domain is a stale local/dev environment by definition — the
 *     legacy host is always the PREVIOUS origin, never the current one.
 */
export function resolveExpectedHost(): { host: string; source: string } {
  const configured = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (configured) {
    let host: string | null = null;
    try {
      host = new URL(
        configured.includes("://") ? configured : `https://${configured}`
      ).hostname.toLowerCase();
    } catch {
      host = null;
    }
    if (host) {
      const normalized = stripWww(host);
      if (isDevelopmentHost(normalized)) {
        return {
          host: productionFallbackHost(),
          source:
            `production fallback (NEXT_PUBLIC_BASE_URL=${configured} is a ` +
            `development origin)`,
        };
      }
      if (normalized === stripWww(LEGACY_SITE_HOST.toLowerCase())) {
        return {
          host: productionFallbackHost(),
          source:
            `production fallback (NEXT_PUBLIC_BASE_URL=${configured} still ` +
            `points at the legacy pre-cutover domain)`,
        };
      }
      return {
        host: normalized,
        source: `NEXT_PUBLIC_BASE_URL (${configured})`,
      };
    }
  }
  return { host: productionFallbackHost(), source: "production fallback" };
}

/**
 * Checks one discovery file's contents against the expected site host.
 * Returns a list of human-readable drift problems (empty when clean).
 */
function checkContent(
  label: string,
  contents: string,
  expectedHost: string
): string[] {
  const expected = stripWww(expectedHost.toLowerCase());
  const legacy = LEGACY_SITE_HOST.toLowerCase();
  const problems: string[] = [];
  let referencesExpected = false;

  for (const url of extractUrls(contents)) {
    if (hostMatches(url.host, expected)) {
      referencesExpected = true;
      continue;
    }
    if (hostMatches(url.host, legacy)) {
      if (OPERATIONAL_PATH_RE.test(url.pathname)) {
        problems.push(
          `${label}: stale operational endpoint on the legacy host: ` +
            `${url.raw} — agents must be sent to the configured origin ` +
            `"${expectedHost}" directly`
        );
      }
      // Bare/page-path legacy URLs are allowed as intentional historical
      // references (the retired domain is still served as platform traffic).
      continue;
    }
    if (EXTERNAL_HOST_ALLOWLIST.has(url.host)) continue;
    problems.push(
      `${label}: unrecognized origin in ${url.raw} — either a stale site ` +
        `domain from a partial cutover (expected "${expectedHost}") or a new ` +
        `external link that must be added to EXTERNAL_HOST_ALLOWLIST in ` +
        `__tests__/utils/geo/discovery-files-site-domain.test.ts`
    );
  }

  if (!referencesExpected) {
    problems.push(
      `${label}: contains no absolute URL to the configured site host ` +
        `"${expectedHost}" — a discovery file must advertise its own origin`
    );
  }

  return problems;
}

// --- Tests -------------------------------------------------------------------

describe("agent-discovery files advertise the configured site domain", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_BASE_URL;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = ORIGINAL;
  });

  it("every absolute URL in the real discovery files is on the configured host, the legacy host (non-operational), or the external allowlist", () => {
    // Uses the configuration AS-IS — no env manipulation — so a cutover that
    // updates NEXT_PUBLIC_BASE_URL without updating the files fails here.
    const { host, source } = resolveExpectedHost();
    const problems = DISCOVERY_FILES.flatMap((file) =>
      checkContent(file, readFileSync(join(process.cwd(), file), "utf8"), host)
    );
    if (problems.length > 0) {
      throw new Error(
        `DRIFT: discovery files advertise the wrong site origin (expected ` +
          `"${host}" from ${source}):\n` +
          problems.map((p) => `  - ${p}`).join("\n") +
          `\nEvery absolute site URL in the public/ discovery files must ` +
          `match the configured site URL (utils/site-url.ts). If this is a ` +
          `domain cutover, update the files under public/.`
      );
    }
    expect(problems).toEqual([]);
  });

  it("fails the real files when NEXT_PUBLIC_BASE_URL changes (no domain is hardcoded)", () => {
    // Stub the env to a neutral domain: the files still point at the real
    // production host, which becomes an UNRECOGNIZED origin, so the check
    // must report drift for every file.
    process.env.NEXT_PUBLIC_BASE_URL = "https://cutover.example";
    const { host, source } = resolveExpectedHost();
    expect(host).toBe("cutover.example");
    expect(source).toContain("cutover.example");

    const problems = DISCOVERY_FILES.flatMap((file) =>
      checkContent(file, readFileSync(join(process.cwd(), file), "utf8"), host)
    );
    // Every discovery file references the production host, so every file must
    // be flagged — proving the assertion is env-driven rather than pinned to
    // either real domain.
    expect(problems.length).toBeGreaterThanOrEqual(DISCOVERY_FILES.length);
    for (const problem of problems) {
      expect(problem).toContain("cutover.example");
    }
    // The flagged origin is the production fallback derived from
    // utils/site-url.ts, not a literal in this test.
    const fallback = productionFallbackHost();
    expect(problems.some((p) => p.includes(`${fallback}`))).toBe(true);
  });

  it("flags a partially updated file even when another URL in it is correct", () => {
    const contents = [
      "Home: https://cutover.example",
      "Endpoint: https://stale-old-domain.example/api/mcp",
      "Source: https://github.com/shopstr-eng/milk-market",
    ].join("\n");
    const problems = checkContent("fixture.txt", contents, "cutover.example");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("stale-old-domain.example/api/mcp");
    expect(problems[0]).toContain("fixture.txt");
  });

  it("flags a stale operational endpoint on the legacy host but allows a historical page reference", () => {
    const stale = [
      "Home: https://cutover.example",
      `Endpoint: https://${LEGACY_SITE_HOST}/api/mcp`,
    ].join("\n");
    const staleProblems = checkContent("fixture.txt", stale, "cutover.example");
    expect(staleProblems).toHaveLength(1);
    expect(staleProblems[0]).toContain("legacy host");
    expect(staleProblems[0]).toContain(`https://${LEGACY_SITE_HOST}/api/mcp`);

    const historical = [
      "Home: https://cutover.example",
      `Formerly https://${LEGACY_SITE_HOST}/about`,
    ].join("\n");
    expect(checkContent("fixture.txt", historical, "cutover.example")).toEqual(
      []
    );
  });

  it("flags a typo'd lookalike domain and a file with no self-reference", () => {
    const typo = [
      "Home: https://cutover.example",
      "Docs: https://cutover-example.com/skill.md",
    ].join("\n");
    const typoProblems = checkContent("fixture.txt", typo, "cutover.example");
    expect(typoProblems).toHaveLength(1);
    expect(typoProblems[0]).toContain("cutover-example.com");

    const noSelfRef = "Source: https://github.com/shopstr-eng/milk-market";
    const selfRefProblems = checkContent(
      "fixture.txt",
      noSelfRef,
      "cutover.example"
    );
    expect(selfRefProblems).toHaveLength(1);
    expect(selfRefProblems[0]).toContain("no absolute URL");
  });

  it("treats development origins and the legacy domain as explicit overrides to the production fallback", () => {
    const fallback = productionFallbackHost();

    process.env.NEXT_PUBLIC_BASE_URL = "http://localhost:5000";
    expect(resolveExpectedHost().host).toBe(fallback);
    expect(resolveExpectedHost().source).toContain("development origin");

    process.env.NEXT_PUBLIC_BASE_URL = "https://abc123.janeway.replit.dev";
    expect(resolveExpectedHost().host).toBe(fallback);

    // A checkout whose env still points at the pre-cutover domain (a stale
    // dev environment) validates against the production fallback instead.
    process.env.NEXT_PUBLIC_BASE_URL = `https://${LEGACY_SITE_HOST}`;
    expect(resolveExpectedHost().host).toBe(fallback);
    expect(resolveExpectedHost().source).toContain("legacy pre-cutover");

    // A non-development configured domain is validated as-is.
    process.env.NEXT_PUBLIC_BASE_URL = "https://cutover.example";
    expect(resolveExpectedHost().host).toBe("cutover.example");
    expect(resolveExpectedHost().source).toContain("NEXT_PUBLIC_BASE_URL");
  });
});
