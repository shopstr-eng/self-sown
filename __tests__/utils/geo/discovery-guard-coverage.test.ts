/** @jest-environment node */

// Coverage guard for the pure-discovery content-claim guards.
//
// discovery-files-no-pricing.test.ts and discovery-files-no-claims.test.ts
// iterate the shared PURE_DISCOVERY_SURFACES list in
// utils/testing/pure-discovery-surfaces.ts to keep membership prices and
// fee/marketing claims out of pure discovery/transport surfaces. That list is
// hand-maintained: if someone adds a new agent-readable API route or a new
// generated-content module under utils/geo/, those guards silently skip it
// until a human remembers to add it — so pricing/claims could leak into the
// new surface unchecked.
//
// This test enumerates the agent-readable surfaces actually on disk and
// asserts each one is either covered by PURE_DISCOVERY_SURFACES or explicitly
// allowlisted below as not-a-pure-discovery-surface. A new route/module fails
// here by name until it is classified one way or the other. It mirrors the
// public/-side coverage guard in discovery-files-coverage.test.ts.

import { readdirSync, statSync } from "fs";
import { join } from "path";
import { PURE_DISCOVERY_SURFACES } from "@/utils/testing/pure-discovery-surfaces";

// Agent-readable routes/modules that are NOT pure discovery/transport
// surfaces for pricing/claim purposes. Each entry is a reviewed exception —
// keep the reason current.
const NOT_PURE_DISCOVERY_SURFACES = new Set([
  // Apple Pay domain-verification token — a fixed string for Apple, no prose.
  "pages/api/.well-known/apple-developer-merchantid-domain-association.ts",
  // Web Bot Auth JWKS directory — public keys, no marketing prose.
  "pages/api/.well-known/http-message-signatures-directory.ts",
  // Rich-content surface: intentionally carries tiers, pricing, and fee
  // claims (guarded by llms-full-price-sync / structured-data-claim-sync).
  "utils/geo/page-content.ts",
  // The canonical source of the fee claims themselves.
  "utils/geo/fee-claims.ts",
  // Country data table (names/codes), no prose.
  "utils/geo/countries.ts",
]);

// Recursively enumerate *.ts route files under pages/api (skipping tests).
function enumerateApiRoutes(dir: string): string[] {
  const abs = join(process.cwd(), dir);
  return readdirSync(abs).flatMap((name) => {
    const rel = `${dir}/${name}`;
    const stat = statSync(join(abs, name));
    if (stat.isDirectory()) return enumerateApiRoutes(rel);
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) return [];
    return [rel];
  });
}

// Agent-readable surfaces a claim could leak into:
//  - any pages/api route with "agent" in the filename (agent-view,
//    stall-agent-view, .well-known/agent.json, …),
//  - every route under pages/api/.well-known/,
//  - the /api/openapi route (OpenAPI spec served to agents),
//  - every generated-content module directly under utils/geo/.
function enumerateCandidates(): string[] {
  const apiRoutes = enumerateApiRoutes("pages/api").filter(
    (file) =>
      file.includes("agent") ||
      file.startsWith("pages/api/.well-known/") ||
      file.startsWith("pages/api/openapi")
  );

  const geoModules = readdirSync(join(process.cwd(), "utils/geo"))
    .filter(
      (name) =>
        statSync(join(process.cwd(), "utils/geo", name)).isFile() &&
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts")
    )
    .map((name) => `utils/geo/${name}`);

  return [...new Set([...apiRoutes, ...geoModules])].sort();
}

describe("every agent-readable route/module is covered by the content-claim guards", () => {
  it("each agent-readable surface is in PURE_DISCOVERY_SURFACES or explicitly allowlisted", () => {
    const uncovered = enumerateCandidates().filter(
      (file) =>
        !PURE_DISCOVERY_SURFACES.includes(file) &&
        !NOT_PURE_DISCOVERY_SURFACES.has(file)
    );

    if (uncovered.length > 0) {
      throw new Error(
        `UNCOVERED: ${uncovered.length} agent-readable route(s)/module(s) ` +
          `are not in the shared PURE_DISCOVERY_SURFACES list ` +
          `(utils/testing/pure-discovery-surfaces.ts) nor in the ` +
          `not-a-pure-discovery-surface allowlist of this test:\n` +
          uncovered.map((file) => `  - ${file}`).join("\n") +
          `\nAdd each file to PURE_DISCOVERY_SURFACES so the ` +
          `no-pricing/no-claims guards check it, or to ` +
          `NOT_PURE_DISCOVERY_SURFACES here if it legitimately carries ` +
          `pricing/claims (rich content) or is not agent-facing prose.`
      );
    }
  });

  it("stale allowlist entries are flagged", () => {
    const onDisk = new Set(enumerateCandidates());
    const stale = [...NOT_PURE_DISCOVERY_SURFACES].filter(
      (file) => !onDisk.has(file)
    );

    if (stale.length > 0) {
      throw new Error(
        `STALE: not-a-pure-discovery-surface allowlist entries no longer on ` +
          `disk:\n` +
          stale.map((file) => `  - ${file}`).join("\n")
      );
    }
  });
});
