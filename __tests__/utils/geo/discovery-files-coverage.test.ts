/** @jest-environment node */

// Coverage guard for the geo discovery-file tests.
//
// The discovery guard tests (site-domain, live-routes) iterate the shared
// DISCOVERY_FILES list in utils/testing/discovery-files.ts. That list is
// hand-maintained: if someone adds a new text/markdown/JSON file under
// public/ or public/.well-known/ that advertises links to agents, every
// guard silently skips it until a human remembers to add it to the list.
//
// This test enumerates the agent-facing files actually on disk and asserts
// each one is either covered by DISCOVERY_FILES or explicitly allowlisted
// below as not-a-discovery-file. A new file fails here by name until it is
// classified one way or the other.

import { readdirSync, statSync } from "fs";
import { join } from "path";
import { DISCOVERY_FILES } from "@/utils/testing/discovery-files";

// Extensions that can advertise links to agents/crawlers. Images, icons,
// GIFs, and the service-worker bundles are not discovery surfaces.
const DISCOVERY_EXTENSIONS = new Set([".txt", ".md", ".json"]);

// Text/markdown/JSON files under public/ that are NOT agent-discovery
// surfaces. Each entry is a reviewed exception — keep the reason current.
const NOT_DISCOVERY_FILES = new Set([
  "public/currencySelection.json", // checkout currency dropdown data
  "public/locationSelection.json", // shipping/location dropdown data
  "public/manifest.json", // PWA install manifest (browser, not agents)
  "public/.well-known/nostr.json", // NIP-05 identity lookup, no agent links
]);

const SCAN_ROOTS = ["public", "public/.well-known"];

function enumerateCandidateFiles(): string[] {
  return SCAN_ROOTS.flatMap((dir) =>
    readdirSync(join(process.cwd(), dir))
      .filter((name) => statSync(join(process.cwd(), dir, name)).isFile())
      .filter((name) =>
        DISCOVERY_EXTENSIONS.has(name.slice(name.lastIndexOf(".")))
      )
      .map((name) => `${dir}/${name}`)
  );
}

describe("every agent-facing file under public/ is covered by the discovery guards", () => {
  it("each text/markdown/JSON file is in DISCOVERY_FILES or explicitly allowlisted", () => {
    const uncovered = enumerateCandidateFiles().filter(
      (file) => !DISCOVERY_FILES.includes(file) && !NOT_DISCOVERY_FILES.has(file)
    );

    if (uncovered.length > 0) {
      throw new Error(
        `UNCOVERED: ${uncovered.length} agent-facing file(s) under public/ ` +
          `are not in the shared DISCOVERY_FILES list ` +
          `(utils/testing/discovery-files.ts) nor in the not-a-discovery-file ` +
          `allowlist of this test:\n` +
          uncovered.map((file) => `  - ${file}`).join("\n") +
          `\nAdd each file to DISCOVERY_FILES so the site-domain/live-routes ` +
          `guards check it, or to NOT_DISCOVERY_FILES here if it does not ` +
          `advertise links to agents.`
      );
    }
  });

  it("stale allowlist entries are flagged", () => {
    const onDisk = new Set(enumerateCandidateFiles());
    const stale = [...NOT_DISCOVERY_FILES].filter((file) => !onDisk.has(file));

    if (stale.length > 0) {
      throw new Error(
        `STALE: not-a-discovery-file allowlist entries no longer on disk:\n` +
          stale.map((file) => `  - ${file}`).join("\n")
      );
    }
  });
});
