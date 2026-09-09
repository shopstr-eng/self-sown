#!/usr/bin/env node
// Compiles styles/globals.css standalone via @tailwindcss/postcss and prints
// the compiled byte size to stdout (a single integer). Used by
// __tests__/styles/globals-css.test.ts as the stylesheet-bloat regression
// guard; also runnable by hand:
//
//   node scripts/check-globals-css.mjs
//
// Kept as a separate script (not in-process in Jest) because Tailwind v4's
// loader registers module customization hooks that the Jest runtime forbids.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const globalsPath = path.join(root, "styles/globals.css");
const css = readFileSync(globalsPath, "utf8");

const result = await postcss([tailwindcss()]).process(css, {
  from: globalsPath,
});

process.stdout.write(String(Buffer.byteLength(result.css, "utf8")));
