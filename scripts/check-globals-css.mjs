#!/usr/bin/env node
// Compiles styles/globals.css standalone via @tailwindcss/postcss and prints
// the compiled byte size to stdout (a single integer). Used by
// __tests__/styles/globals-css.test.ts as the stylesheet regression guard;
// also runnable by hand:
//
//   node scripts/check-globals-css.mjs
//
// Kept as a separate script (not in-process in Jest) because Tailwind v4's
// loader registers module customization hooks that the Jest runtime forbids.
//
// Beyond the byte size, this script fails loudly (stderr + exit 1) when:
//   1. A package scanned by a Tailwind `@source "../node_modules/..."` glob is
//      NOT pnpm-managed. pnpm's isolated node_modules only materializes DIRECT
//      dependencies as symlinks into .pnpm; a transitive dep — or a stale real
//      directory left by an old install masking the layout — means the @source
//      glob silently matches nothing (or the wrong thing) on fresh installs.
//      We require the scanned package root to be a symlink AND to resolve
//      (via require.resolve, which dereferences symlinks) into `.pnpm`.
//   2. Marker selectors from those scanned packages are missing from the
//      compiled CSS. @source globs fail silently on zero matches, so the
//      build stays green while hundreds of component classes vanish — this
//      is how the published site lost ~880 HeroUI slot classes (input label
//      float, image reveal, focus rings) while dev looked fine.
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const globalsPath = path.join(root, "styles/globals.css");
const css = readFileSync(globalsPath, "utf8");

function fail(message) {
  process.stderr.write(`check-globals-css: ${message}\n`);
  process.exit(1);
}

// --- Guard 1: every node_modules @source target must be pnpm-managed --------
// Matches `@source "../node_modules/<pkg>/...";` and extracts the package
// specifier (handles scoped packages like "@heroui/theme").
const NODE_MODULES_SOURCE_RE =
  /^@source\s+["']\.\.\/node_modules\/((?:@[^/"']+\/)?[^/"']+)[^"']*["']\s*;/gm;

const require = createRequire(path.join(root, "package.json"));
const scannedPackages = [
  ...new Set(
    [...css.matchAll(NODE_MODULES_SOURCE_RE)]
      .map((m) => m[1])
      .filter((p) => p !== undefined),
  ),
];

for (const pkg of scannedPackages) {
  const pkgDir = path.join(root, "node_modules", pkg);
  let stat;
  try {
    stat = lstatSync(pkgDir);
  } catch {
    fail(
      `@source scans node_modules/${pkg}, but that package is not installed ` +
        `at the top level. Under pnpm only DIRECT dependencies get a top-level ` +
        `entry — add "${pkg}" to package.json dependencies.`,
    );
  }
  if (!stat.isSymbolicLink()) {
    fail(
      `node_modules/${pkg} is a real directory, not a pnpm-managed symlink. ` +
        `A stale directory from an old install can mask a missing direct ` +
        `dependency: the @source glob compiles fine locally but matches ` +
        `nothing after a fresh pnpm install. Remove node_modules and ` +
        `reinstall, and make sure "${pkg}" is a direct dependency.`,
    );
  }
  const resolved = require.resolve(`${pkg}/package.json`);
  if (!resolved.includes(`${path.sep}.pnpm${path.sep}`)) {
    fail(
      `"${pkg}" resolved to ${resolved}, which is outside pnpm's .pnpm store. ` +
        `The @source glob must scan the pnpm-managed copy or fresh installs ` +
        `can silently change what gets compiled.`,
    );
  }
}

// --- Compile -----------------------------------------------------------------
const result = await postcss([tailwindcss()]).process(css, {
  from: globalsPath,
});

// --- Guard 2: marker selectors must survive compilation ----------------------
// One marker per distinct symptom class from the HeroUI incident, written as
// the exact escaped form Tailwind v4 emits. If a @source glob stops matching,
// these disappear from the output.
const REQUIRED_MARKERS = [
  // HeroUI input label float (without it, labels render stuck on top of
  // placeholders in every labeled input).
  "group-data-\\[filled-within\\=true\\]\\:scale-85",
  // HeroUI Image/Avatar reveal (without it, images stay invisible site-wide).
  "data-\\[loaded\\=true\\]\\:opacity-100",
];

const missing = REQUIRED_MARKERS.filter((marker) => !result.css.includes(marker));
if (missing.length > 0) {
  fail(
    `compiled stylesheet is missing marker selector(s):\n` +
      missing.map((m) => `  - ${m}`).join("\n") +
      `\nA Tailwind @source glob into node_modules is silently matching ` +
      `nothing. Check that the scanned package (see styles/globals.css) is a ` +
      `direct dependency and pnpm-managed (symlink into .pnpm).`,
  );
}

process.stdout.write(String(Buffer.byteLength(result.css, "utf8")));
