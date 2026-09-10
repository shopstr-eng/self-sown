/** @jest-environment node */

// Companion to discovery-files-site-domain.test.ts.
//
// That sibling test checks the HOST every discovery-file URL points at; this
// test checks the PATH. The static discovery files under public/ advertise
// concrete endpoints to agents and crawlers (/api/mcp, /.well-known/ucp,
// /openapi.json, /sitemap.xml, …). If a route is renamed or removed, the
// files keep sending agents to it and nothing fails loudly: agent 404s route
// through tryWriteAgentNotFound (see proxy.ts), so the link rots silently.
//
// Policy enforced here for every same-origin absolute URL and every
// root-relative path in each discovery file:
//
//   The advertised path must resolve to a real route:
//     1. a file under public/ (llms.txt, .well-known/mcp.json, …),
//     2. a page/API route under pages/ (including dynamic segments: {id},
//        <slug>, and concrete instances of [param] routes),
//     3. a static rewrite in next.config.mjs (/openapi.json →
//        /api/openapi.json, …) whose destination resolves,
//     4. a proxy-handled path in proxy.ts (/.well-known/ucp, …) whose
//        conventional backing route (/api + path) exists,
//   …or be listed explicitly in DEAD_PATH_ALLOWLIST below.
//
// robots/agents directive lines (Disallow:, Allow:, Rate-Limit:, …) carry
// path PREFIXES, not routable endpoints, so they are skipped. The 404
// catch-all routes ([...notFound]) never satisfy a lookup — resolving through
// them is exactly the soft-404 this test exists to catch.
//
// Failures name the discovery file and the dead path.

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { getSiteHost } from "@/utils/site-url";

const ROOT = process.cwd();

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

// Paths the discovery files may advertise even though no route serves them
// (intentionally external-only pointers). Kept explicit so a genuinely dead
// link can never slip in silently — an entry here is a reviewed exception.
const DEAD_PATH_ALLOWLIST = new Set<string>([]);

// Absolute URLs only (same shape as the sibling host test). Root-relative
// paths: a leading slash after whitespace/quote/paren/backtick, one or more
// segments of URL-path characters including route-template markers.
const ABSOLUTE_URL_RE = /https?:\/\/[^\s"'<>)\]`]+/g;
const ROOT_RELATIVE_RE =
  /(?:^|[\s("'`])((?:\/[A-Za-z0-9._~{}\[\]<>-]+)+\/?)/g;

// robots/agents directive values are crawl PREFIXES (Disallow: /api/), not
// advertised endpoints — a prefix matching no route is not a dead link.
const DIRECTIVE_LINE_RE = /^\s*(disallow|allow|rate-limit|crawl-delay)\s*:/i;

const PAGE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

// This repo's soft-404 catch-alls (pages/[...notFound].tsx,
// pages/api/[...notFound].ts). They "route" everything, so letting them
// satisfy a lookup would make the whole test vacuous.
function isNotFoundCatchAll(name: string): boolean {
  return /notfound/i.test(name);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice("www.".length) : host;
}

function isTemplateSegment(segment: string): boolean {
  return (
    (segment.startsWith("{") && segment.endsWith("}")) ||
    (segment.startsWith("<") && segment.endsWith(">")) ||
    (segment.startsWith("[") && segment.endsWith("]"))
  );
}

function isDynamicEntry(name: string): boolean {
  return (
    name.startsWith("[") &&
    !name.startsWith("_") &&
    !isNotFoundCatchAll(name)
  );
}

function routableEntries(dir: string): string[] {
  try {
    return readdirSync(dir).filter(
      (name) => !name.startsWith("_") && !isNotFoundCatchAll(name)
    );
  } catch {
    return [];
  }
}

function hasIndexRoute(dir: string): boolean {
  return PAGE_EXTENSIONS.some((ext) => isFile(join(dir, `index${ext}`)));
}

// An optional catch-all ([[...npub]].tsx) routes the bare directory path too
// (e.g. /marketplace), not just paths below it.
function hasOptionalCatchAll(dir: string): boolean {
  return routableEntries(dir).some(
    (entry) =>
      /^\[\[\.\.\..+\]\]\.(tsx|ts|jsx|js)$/.test(entry) &&
      isFile(join(dir, entry))
  );
}

function dirRoutesBarePath(dir: string): boolean {
  return hasIndexRoute(dir) || hasOptionalCatchAll(dir);
}

/**
 * Walks the pages/ tree for a route matching the segments. Literal segments
 * match literal files/dirs first and dynamic [param] entries second (mirroring
 * Next.js routing, so /listing/abc resolves via [id].tsx). Template segments
 * ({id}, <slug>, [slug]) match dynamic entries only.
 */
function segmentsResolve(dir: string, segments: string[]): boolean {
  if (!isDir(dir)) return false;
  const head = segments[0];
  if (head === undefined) return false;
  const rest = segments.slice(1);
  const template = isTemplateSegment(head);

  if (rest.length === 0) {
    if (!template) {
      for (const ext of PAGE_EXTENSIONS) {
        if (isFile(join(dir, head + ext))) return true;
      }
      if (isDir(join(dir, head)) && dirRoutesBarePath(join(dir, head)))
        return true;
    }
    for (const entry of routableEntries(dir)) {
      if (!isDynamicEntry(entry)) continue;
      const full = join(dir, entry);
      if (isFile(full) && PAGE_EXTENSIONS.some((ext) => entry.endsWith(ext)))
        return true;
      if (isDir(full) && hasIndexRoute(full)) return true;
    }
    return false;
  }

  if (
    !template &&
    isDir(join(dir, head)) &&
    segmentsResolve(join(dir, head), rest)
  ) {
    return true;
  }
  for (const entry of routableEntries(dir)) {
    if (!isDynamicEntry(entry)) continue;
    const full = join(dir, entry);
    if (isDir(full) && segmentsResolve(full, rest)) return true;
  }
  return false;
}

/** A pages/ route exists for the path (e.g. "/api/mcp", "/stall/[slug]"). */
function pageRouteExists(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return PAGE_EXTENSIONS.some((ext) =>
      isFile(join(ROOT, "pages", `index${ext}`))
    );
  }
  return segmentsResolve(join(ROOT, "pages"), segments);
}

/** A trailing-slash reference is a route PREFIX: its pages/ dir must exist. */
function prefixRouteExists(pathname: string): boolean {
  const dir = join(ROOT, "pages", pathname.replace(/\/+$/, ""));
  return isDir(dir) && routableEntries(dir).length > 0;
}

/** Static (non-parameterized) rewrites from next.config.mjs. */
function loadStaticRewrites(): Map<string, string> {
  const config = readFileSync(join(ROOT, "next.config.mjs"), "utf8");
  const rewrites = new Map<string, string>();
  const re = /source:\s*"([^"]+)"[\s\S]*?destination:\s*"([^"]+)"/g;
  for (const match of config.matchAll(re)) {
    const source = match[1];
    const destination = match[2];
    if (source === undefined || destination === undefined) continue;
    // Parameterized/regex sources can't be matched against concrete paths.
    if (/[:(]/.test(source) || /[:(]/.test(destination)) continue;
    rewrites.set(source, (destination.split("?")[0] ?? "") as string);
  }
  return rewrites;
}

/** Paths the proxy intercepts directly (pathname === "…" literals). */
function loadProxyHandledPaths(): Set<string> {
  const proxy = readFileSync(join(ROOT, "proxy.ts"), "utf8");
  const paths = new Set<string>();
  for (const match of proxy.matchAll(/pathname\s*===\s*"([^"]+)"/g)) {
    if (match[1] !== undefined) paths.add(match[1]);
  }
  return paths;
}

const STATIC_REWRITES = loadStaticRewrites();
const PROXY_HANDLED_PATHS = loadProxyHandledPaths();

interface Resolution {
  ok: boolean;
  detail?: string;
}

function fail(detail: string): Resolution {
  return { ok: false, detail };
}

const NO_ROUTE_DETAIL =
  "no matching public/ file, pages/ route, next.config.mjs rewrite, or " +
  "proxy-handled route. If the route was renamed or removed, update the " +
  "discovery file; if the path is intentionally external-only, add it to " +
  "DEAD_PATH_ALLOWLIST in __tests__/utils/geo/discovery-files-live-routes.test.ts";

function resolveAdvertisedPath(pathname: string): Resolution {
  if (DEAD_PATH_ALLOWLIST.has(pathname)) return { ok: true };

  // A trailing-slash reference is a route prefix, not an endpoint.
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return prefixRouteExists(pathname)
      ? { ok: true }
      : fail(`route prefix has no routes under pages/: ${NO_ROUTE_DETAIL}`);
  }

  if (pathname === "/") {
    return pageRouteExists("/")
      ? { ok: true }
      : fail(`homepage route missing: ${NO_ROUTE_DETAIL}`);
  }

  // 1. Static file under public/.
  if (isFile(join(ROOT, "public", pathname))) return { ok: true };

  // 2. Static rewrite in next.config.mjs whose destination resolves.
  const destination = STATIC_REWRITES.get(pathname);
  if (destination !== undefined) {
    return pageRouteExists(destination)
      ? { ok: true }
      : fail(
          `next.config.mjs rewrites it to "${destination}", but no pages/ ` +
            `route exists for that destination`
        );
  }

  // 3. A pages/ route (page or API route, dynamic segments included).
  if (pageRouteExists(pathname)) return { ok: true };

  // 4. A proxy.ts-intercepted path (e.g. /.well-known/ucp). The proxy
  //    rewrites these to an internal API route of the same name; require
  //    that backing route to exist so a renamed API route is caught.
  if (PROXY_HANDLED_PATHS.has(pathname)) {
    const backing = `/api${pathname}`;
    return pageRouteExists(backing)
      ? { ok: true }
      : fail(
          `proxy.ts intercepts it, but the backing route "${backing}" has ` +
            `no pages/ entry`
        );
  }

  return fail(NO_ROUTE_DETAIL);
}

/** The hosts that mean "this site": configured host + production fallback. */
function siteHosts(): Set<string> {
  const hosts = new Set<string>();
  const original = process.env.NEXT_PUBLIC_BASE_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  try {
    hosts.add(stripWww(getSiteHost().toLowerCase()));
  } finally {
    if (original !== undefined) process.env.NEXT_PUBLIC_BASE_URL = original;
  }
  if (original?.trim()) {
    try {
      const parsed = new URL(
        original.includes("://") ? original : `https://${original}`
      );
      hosts.add(stripWww(parsed.hostname.toLowerCase()));
    } catch {
      // Unparseable configured URL — the sibling host test flags that.
    }
  }
  return hosts;
}

/** Strips closers only when unbalanced, so [slug]/{id} tokens survive. */
function stripUnbalancedClosers(token: string): string {
  const pairs: Array<[string, string]> = [
    ["[", "]"],
    ["{", "}"],
  ];
  let out = token;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of pairs) {
      const opens = out.split(open).length - 1;
      const closes = out.split(close).length - 1;
      if (out.endsWith(close) && closes > opens) {
        out = out.slice(0, -1);
        changed = true;
      }
    }
  }
  return out;
}

interface AdvertisedPath {
  path: string;
  via: string;
}

function extractAdvertisedPaths(
  contents: string,
  hosts: Set<string>
): AdvertisedPath[] {
  const found: AdvertisedPath[] = [];

  for (const match of contents.matchAll(ABSOLUTE_URL_RE)) {
    const raw = match[0].replace(/[.,;:]+$/, "");
    try {
      const parsed = new URL(raw);
      if (!hosts.has(stripWww(parsed.hostname.toLowerCase()))) continue;
      found.push({ path: parsed.pathname || "/", via: raw });
    } catch {
      // Not a parseable URL after extraction.
    }
  }

  for (const line of contents.split("\n")) {
    if (DIRECTIVE_LINE_RE.test(line)) continue;
    for (const match of line.matchAll(ROOT_RELATIVE_RE)) {
      const captured = match[1];
      if (captured === undefined) continue;
      let token = captured.replace(/[.,;:]+$/, "");
      token = stripUnbalancedClosers(token);
      if (token.length > 1) found.push({ path: token, via: token });
    }
  }

  return found;
}

/**
 * Checks one discovery file's contents for advertised paths that resolve to
 * no real route. Returns human-readable problems (empty when clean), each
 * naming the file and the dead path.
 */
function findDeadPaths(
  label: string,
  contents: string,
  hosts: Set<string>
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { path, via } of extractAdvertisedPaths(contents, hosts)) {
    if (seen.has(path)) continue;
    seen.add(path);
    const resolution = resolveAdvertisedPath(path);
    if (!resolution.ok) {
      problems.push(`${label}: dead advertised path ${path} (via "${via}") — ${resolution.detail}`);
    }
  }
  return problems;
}

// --- Tests -------------------------------------------------------------------

describe("agent-discovery files advertise only live routes", () => {
  it("every same-origin path advertised in the real discovery files resolves to a real route", () => {
    const hosts = siteHosts();
    const problems = DISCOVERY_FILES.flatMap((file) =>
      findDeadPaths(
        file,
        readFileSync(join(ROOT, file), "utf8"),
        hosts
      )
    );
    if (problems.length > 0) {
      throw new Error(
        `DEAD LINKS: discovery files advertise paths with no route:\n` +
          problems.map((p) => `  - ${p}`).join("\n") +
          `\nAgents and crawlers follow these links; a renamed or removed ` +
          `route must be updated in the public/ discovery files (or ` +
          `allowlisted in DEAD_PATH_ALLOWLIST if intentionally external-only).`
      );
    }
    expect(problems).toEqual([]);
  });

  it("flags a dead path with the file name and the path, and passes live ones", () => {
    const host = [...siteHosts()][0];
    const contents = [
      `Endpoint: https://${host}/api/mcp`,
      `Skill: https://${host}/skill.md`,
      "See /api/ucp/catalog/search and /llms.txt for discovery.",
      `Gone: https://${host}/api/definitely-dead-endpoint-327`,
      "Also gone: /no-such-page-327 anywhere.",
    ].join("\n");
    const problems = findDeadPaths("fixture.txt", contents, siteHosts());
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("fixture.txt");
    expect(problems[0]).toContain("/api/definitely-dead-endpoint-327");
    expect(problems[1]).toContain("/no-such-page-327");
  });

  it("resolves dynamic route templates ({id}, <slug>) and concrete instances of [param] routes", () => {
    const contents = [
      "Track: GET /api/ucp/checkout/sessions/{id}",
      "Storefront: /stall/<slug> serves the seller's stall.",
      "Stalls live under /stall/ generally.",
    ].join("\n");
    expect(findDeadPaths("fixture.txt", contents, siteHosts())).toEqual([]);
  });

  it("ignores robots/agents directive prefixes and other-host URLs", () => {
    const contents = [
      "User-agent: *",
      "Disallow: /not-a-real-prefix-327/",
      "Allow: /",
      "Rate-Limit: 600 requests/minute per IP on /api/mcp",
      "External: https://example.com/also-not-checked-327",
      "# but a pointer comment is checked: /llms.txt",
    ].join("\n");
    expect(findDeadPaths("fixture.txt", contents, siteHosts())).toEqual([]);
  });

  it("never lets the 404 catch-all routes satisfy a lookup", () => {
    const problems = findDeadPaths(
      "fixture.txt",
      "Docs moved to /totally-unknown-path-327.",
      siteHosts()
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("/totally-unknown-path-327");
  });

  it("honors DEAD_PATH_ALLOWLIST for intentionally external-only paths", () => {
    const resolution = resolveAdvertisedPath("/api/definitely-dead-endpoint-327");
    expect(resolution.ok).toBe(false);
    DEAD_PATH_ALLOWLIST.add("/api/definitely-dead-endpoint-327");
    try {
      expect(
        resolveAdvertisedPath("/api/definitely-dead-endpoint-327").ok
      ).toBe(true);
    } finally {
      DEAD_PATH_ALLOWLIST.delete("/api/definitely-dead-endpoint-327");
    }
  });
});
