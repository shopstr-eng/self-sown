/** @jest-environment node */

// Companion to __tests__/utils/geo/discovery-files-live-routes.test.ts.
//
// That test verifies every path advertised in the static public/ discovery
// files resolves to a real route. The OpenAPI document (pages/api/
// openapi.json.ts, served at /openapi.json) is the OTHER place agents get an
// endpoint list, and it is maintained by hand — a removed or renamed route
// can stay listed in spec.paths with nothing failing. Agents follow these
// paths; a dead one routes through tryWriteAgentNotFound as a soft 404.
//
// Policy: every path key in spec.paths must resolve to a real route via the
// shared resolver (public/ file, pages/ route incl. {template} segments,
// next.config.mjs rewrite, or proxy-handled path) — or be listed explicitly
// in DEAD_PATH_ALLOWLIST below. Failures name the dead OpenAPI path.

import handler from "@/pages/api/openapi.json";
import { resolveAdvertisedPath } from "@/utils/testing/route-resolution";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// Paths the OpenAPI document may advertise even though no route serves them
// (intentionally external-only pointers). Kept explicit so a genuinely dead
// path can never slip in silently — an entry here is a reviewed exception.
const DEAD_PATH_ALLOWLIST = new Set<string>([]);

// Routes whose method dispatch is intentionally opaque to source inspection:
// static files have no handler, while these GET-only handlers serve GET by
// convention without reading req.method.
const METHOD_DISPATCH_ALLOWLIST = new Set([
  "GET /llms.txt",
  "GET /.well-known/mcp.json",
  "GET /.well-known/agent-card.json",
  "GET /.well-known/l402.json",
  "GET /rss.xml",
  "GET /sitemap.xml",
  "GET /api/mcp/status",
]);

const ROUTE_SOURCE_OVERRIDES: Record<string, string> = {
  "/rss.xml": "pages/api/rss.xml.ts",
  "/sitemap.xml": "pages/api/sitemap.xml.ts",
  "/.well-known/ucp": "pages/api/.well-known/ucp.ts",
};

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
] as const;

function loadSpec(): any {
  let payload: any;
  const res = {
    setHeader: jest.fn(),
    status(code: number) {
      expect(code).toBe(200);
      return this;
    },
    json(body: any) {
      payload = body;
      return this;
    },
  } as any;
  handler({} as any, res);
  return payload;
}

const spec = loadSpec();

function findDeadSpecPaths(): string[] {
  const problems: string[] = [];
  for (const path of Object.keys(spec.paths)) {
    const resolution = resolveAdvertisedPath(path, DEAD_PATH_ALLOWLIST);
    if (!resolution.ok) {
      problems.push(
        `openapi.json: dead advertised path ${path} — ${resolution.detail}`
      );
    }
  }
  return problems;
}

function routeSourcePath(pathname: string): string | undefined {
  const override = ROUTE_SOURCE_OVERRIDES[pathname];
  if (override) return join(process.cwd(), override);
  if (!pathname.startsWith("/api/")) return undefined;

  const base = join(
    process.cwd(),
    "pages",
    pathname.replace(/\{([^}]+)\}/g, "[$1]")
  );
  return [".ts", ".tsx", ".js", ".jsx"]
    .flatMap((extension) => [
      `${base}${extension}`,
      join(base, `index${extension}`),
    ])
    .find(existsSync);
}

function sourceHandlesMethod(source: string, method: string): boolean {
  const upper = method.toUpperCase();
  return (
    new RegExp(
      String.raw`\b(?:req|request)\.method\s*(?:===|!==)\s*["']${upper}["']`
    ).test(source) ||
    new RegExp(String.raw`\bcase\s+["']${upper}["']\s*:`).test(source) ||
    new RegExp(String.raw`\bexport\s+(?:async\s+)?function\s+${upper}\b`).test(
      source
    )
  );
}

function findUnsupportedSpecMethods(): string[] {
  const problems: string[] = [];
  for (const [pathname, pathItem] of Object.entries<any>(spec.paths)) {
    for (const method of HTTP_METHODS) {
      if (!pathItem[method]) continue;
      const operation = `${method.toUpperCase()} ${pathname}`;
      if (METHOD_DISPATCH_ALLOWLIST.has(operation)) continue;

      const sourcePath = routeSourcePath(pathname);
      if (!sourcePath) {
        problems.push(`${operation} — no inspectable route module`);
        continue;
      }
      if (!sourceHandlesMethod(readFileSync(sourcePath, "utf8"), method)) {
        problems.push(
          `${operation} — backing route does not handle ${method.toUpperCase()}`
        );
      }
    }
  }
  return problems;
}

describe("openapi.json advertises only live routes", () => {
  it("the document declares paths (guard against a vacuous pass)", () => {
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });

  it("every path in the OpenAPI document resolves to a real route", () => {
    const problems = findDeadSpecPaths();
    if (problems.length > 0) {
      throw new Error(
        `DEAD ENDPOINTS: openapi.json lists paths with no route:\n` +
          problems.map((p) => `  - ${p}`).join("\n") +
          `\nAgents follow these endpoints; a renamed or removed route must ` +
          `be updated in pages/api/openapi.json.ts (or allowlisted in ` +
          `DEAD_PATH_ALLOWLIST if intentionally external-only).`
      );
    }
    expect(problems).toEqual([]);
  });

  it("every advertised operation is handled by its backing route", () => {
    const problems = findUnsupportedSpecMethods();
    if (problems.length > 0) {
      throw new Error(
        `UNSUPPORTED METHODS: openapi.json advertises operations their routes do not handle:\n` +
          problems.map((p) => `  - ${p}`).join("\n") +
          `\nAdd the method to the route, remove it from pages/api/openapi.json.ts, ` +
          `or explicitly review and add opaque dispatch to METHOD_DISPATCH_ALLOWLIST.`
      );
    }
    expect(problems).toEqual([]);
  });

  it("flags a dead path with the path name, and resolves template paths", () => {
    const dead = resolveAdvertisedPath(
      "/api/definitely-dead-endpoint-333",
      DEAD_PATH_ALLOWLIST
    );
    expect(dead.ok).toBe(false);

    // {id}-style template segments in the spec map to [param] routes.
    expect(
      resolveAdvertisedPath(
        "/api/ucp/checkout/sessions/{id}",
        DEAD_PATH_ALLOWLIST
      ).ok
    ).toBe(true);
  });

  it("recognizes supported methods and rejects mismatches", () => {
    expect(
      sourceHandlesMethod(`if (req.method !== "POST") return;`, "post")
    ).toBe(true);
    expect(
      sourceHandlesMethod(`if (req.method !== "POST") return;`, "get")
    ).toBe(false);
  });
});
