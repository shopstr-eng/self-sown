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

// Paths the OpenAPI document may advertise even though no route serves them
// (intentionally external-only pointers). Kept explicit so a genuinely dead
// path can never slip in silently — an entry here is a reviewed exception.
const DEAD_PATH_ALLOWLIST = new Set<string>([]);

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
      problems.push(`openapi.json: dead advertised path ${path} — ${resolution.detail}`);
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
});
