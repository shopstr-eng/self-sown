#!/usr/bin/env node
// Prepares the Next.js standalone bundle for serving: folds .next/static and
// public/ into .next/standalone (a plain `next build` does NOT copy these —
// without them the standalone server 404s every static asset) and repairs the
// Sharp native packages pnpm's tracing can drop.
//
// Used by:
//   - scripts/start-standalone.mjs (`pnpm start`) — Sharp repair is
//     best-effort: a self-host seller's site must still boot if the repair
//     can't run; image optimization degrades, pages still serve.
//   - scripts/deploy-build.sh (--strict-sharp) — the deploy build must FAIL
//     loudly on a Sharp problem, as scripts/copy-sharp-standalone.mjs always
//     did when invoked directly.

import fs from "node:fs";
import path from "node:path";
import { repairSharpStandalone } from "./copy-sharp-standalone.mjs";

const strictSharp = process.argv.includes("--strict-sharp");
const root = process.cwd();
const standaloneDir = path.join(root, ".next", "standalone");

if (!fs.existsSync(path.join(standaloneDir, "server.js"))) {
  console.error(
    '[prepare-standalone] .next/standalone/server.js not found — run "pnpm build" first.'
  );
  process.exit(1);
}

function foldIntoStandalone(relativeSource, relativeDestination, label) {
  const source = path.join(root, relativeSource);
  const destination = path.join(standaloneDir, relativeDestination);
  if (!fs.existsSync(source)) {
    console.error(
      `[prepare-standalone] WARNING: ${label} (${relativeSource}) not found; skipping.`
    );
    return;
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true });
}

foldIntoStandalone(
  path.join(".next", "static"),
  path.join(".next", "static"),
  "static assets"
);
foldIntoStandalone("public", "public", "public assets");

try {
  repairSharpStandalone(root);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (strictSharp) {
    console.error(`[prepare-standalone] ${message}`);
    process.exit(1);
  }
  console.error(
    `[prepare-standalone] WARNING: ${message} — image optimization may not work; the site will still serve.`
  );
}
