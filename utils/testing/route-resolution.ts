// Shared route-resolution helpers for tests that assert an advertised path
// (discovery files under public/, the OpenAPI document at /openapi.json)
// resolves to a real route. Extracted from
// __tests__/utils/geo/discovery-files-live-routes.test.ts so both that test
// and the OpenAPI dead-path test enforce the same policy:
//
//   The advertised path must resolve to a real route:
//     1. a file under public/ (llms.txt, .well-known/mcp.json, …),
//     2. a page/API route under pages/ (including dynamic segments: {id},
//        <slug>, and concrete instances of [param] routes),
//     3. a static rewrite in next.config.mjs (/openapi.json →
//        /api/openapi.json, …) whose destination resolves,
//     4. a proxy-handled path in proxy.ts (/.well-known/ucp, …) whose
//        conventional backing route (/api + path) exists,
//   …or be listed explicitly in the caller's dead-path allowlist.
//
// The 404 catch-all routes ([...notFound]) never satisfy a lookup — resolving
// through them is exactly the soft-404 these tests exist to catch.

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

export const ROUTE_RESOLUTION_ROOT = process.cwd();

export const PAGE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

// This repo's soft-404 catch-alls (pages/[...notFound].tsx,
// pages/api/[...notFound].ts). They "route" everything, so letting them
// satisfy a lookup would make the tests vacuous.
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
export function pageRouteExists(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return PAGE_EXTENSIONS.some((ext) =>
      isFile(join(ROUTE_RESOLUTION_ROOT, "pages", `index${ext}`))
    );
  }
  return segmentsResolve(join(ROUTE_RESOLUTION_ROOT, "pages"), segments);
}

/** A trailing-slash reference is a route PREFIX: its pages/ dir must exist. */
export function prefixRouteExists(pathname: string): boolean {
  const dir = join(
    ROUTE_RESOLUTION_ROOT,
    "pages",
    pathname.replace(/\/+$/, "")
  );
  return isDir(dir) && routableEntries(dir).length > 0;
}

/** Static (non-parameterized) rewrites from next.config.mjs. */
function loadStaticRewrites(): Map<string, string> {
  const config = readFileSync(
    join(ROUTE_RESOLUTION_ROOT, "next.config.mjs"),
    "utf8"
  );
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
  const proxy = readFileSync(join(ROUTE_RESOLUTION_ROOT, "proxy.ts"), "utf8");
  const paths = new Set<string>();
  for (const match of proxy.matchAll(/pathname\s*===\s*"([^"]+)"/g)) {
    if (match[1] !== undefined) paths.add(match[1]);
  }
  return paths;
}

const STATIC_REWRITES = loadStaticRewrites();
const PROXY_HANDLED_PATHS = loadProxyHandledPaths();

export interface Resolution {
  ok: boolean;
  detail?: string;
}

function fail(detail: string): Resolution {
  return { ok: false, detail };
}

const NO_ROUTE_DETAIL =
  "no matching public/ file, pages/ route, next.config.mjs rewrite, or " +
  "proxy-handled route. If the route was renamed or removed, update the " +
  "advertising document; if the path is intentionally external-only, add it " +
  "to the caller's dead-path allowlist";

/**
 * Resolves an advertised path against the four route sources. `allowlist`
 * holds reviewed exceptions (intentionally external-only pointers).
 */
export function resolveAdvertisedPath(
  pathname: string,
  allowlist: ReadonlySet<string> = new Set()
): Resolution {
  if (allowlist.has(pathname)) return { ok: true };

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
  if (isFile(join(ROUTE_RESOLUTION_ROOT, "public", pathname)))
    return { ok: true };

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
