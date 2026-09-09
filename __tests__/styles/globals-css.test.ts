/**
 * Regression guard for the Tailwind v4 cold-build OOM / stylesheet-bloat fix.
 *
 * Root cause of the incident: a bare `@import "tailwindcss"` triggers v4's
 * automatic source detection, which walks the ENTIRE workspace — including the
 * multi-GB `.local/` and `.cache/` directories (not covered by our
 * .gitignore-based ignores). That scan peaked at ~5.3GB RSS (cold `next build`
 * OOM) and injected ~107KB of garbage utility rules scraped from junk files
 * into the shipped CSS.
 *
 * The fix is `source(none)` + explicit `@source` globs in styles/globals.css,
 * kept in sync with tailwind.config.ts `content`. These tests fail if:
 *   1. globals.css loses the `source(none)` directive (or gains a bare
 *      tailwind import),
 *   2. the compiled stylesheet grows beyond a sane byte budget (a stray broad
 *      `@source` glob reintroducing junk-file bloat shows up here),
 *   3. tailwind.config.ts `content` globs and the `@source` lines drift apart.
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";

const GLOBALS_CSS_PATH = path.join(__dirname, "../../styles/globals.css");
const TAILWIND_CONFIG_PATH = path.join(__dirname, "../../tailwind.config.ts");

// Measured baseline is ~497KB (Tailwind 4.3.3). 700KB leaves generous headroom
// for legitimate utility growth while still catching the junk-file scan, which
// added ~107KB of garbage plus whatever it finds next time.
const MAX_COMPILED_CSS_BYTES = 700 * 1024;

const globalsCss = readFileSync(GLOBALS_CSS_PATH, "utf8");
const tailwindConfigSource = readFileSync(TAILWIND_CONFIG_PATH, "utf8");

/** All `@import "tailwindcss" ...;` directives found in globals.css. */
function tailwindImports(css: string): string[] {
  const matches = css.match(/^@import\s+["']tailwindcss["'][^;]*;/gm);
  return matches ?? [];
}

/** File-glob `@source` directives (excludes `@source inline(...)`). */
function sourceGlobs(css: string): string[] {
  const matches = css.matchAll(/^@source\s+["']([^"']+)["']\s*;/gm);
  return [...matches]
    .map((m) => m[1])
    .filter((g): g is string => g !== undefined);
}

/** String literals inside the `content: [...]` array of tailwind.config.ts. */
function configContentGlobs(configSource: string): string[] {
  const contentBlock = configSource.match(/content:\s*\[([\s\S]*?)\]/);
  if (!contentBlock || contentBlock[1] === undefined) return [];
  return [...contentBlock[1].matchAll(/["']([^"']+)["']/g)]
    .map((m) => m[1])
    .filter((g): g is string => g !== undefined);
}

describe("globals.css Tailwind source-detection guard", () => {
  it("imports tailwindcss with source(none) so automatic source detection stays off", () => {
    const imports = tailwindImports(globalsCss);
    expect(imports.length).toBeGreaterThan(0);
    for (const directive of imports) {
      // A bare `@import "tailwindcss";` (no source(none)) re-enables the
      // workspace-wide scan that caused the OOMs.
      expect(directive).toContain("source(none)");
    }
  });

  it("keeps tailwind.config.ts content globs and globals.css @source globs in sync", () => {
    // tailwind.config.ts paths are workspace-root-relative ("./pages/**");
    // globals.css @source paths are relative to styles/ ("../pages/**").
    const fromConfig = configContentGlobs(tailwindConfigSource)
      .map((g) => g.replace(/^\.\//, "../"))
      .sort();
    const fromCss = sourceGlobs(globalsCss).sort();
    expect(fromCss).toEqual(fromConfig);
  });

  it(
    "compiles to a stylesheet within the size budget",
    () => {
      // Compiled in a child Node process: Tailwind v4's loader registers
      // module customization hooks that the Jest runtime forbids in-process.
      const scriptPath = path.join(
        __dirname,
        "../../scripts/check-globals-css.mjs",
      );
      const stdout = execFileSync(process.execPath, [scriptPath], {
        encoding: "utf8",
        timeout: 110_000,
      });
      const bytes = parseInt(stdout.trim(), 10);
      expect(Number.isNaN(bytes)).toBe(false);
      expect(bytes).toBeLessThan(MAX_COMPILED_CSS_BYTES);
    },
    120_000,
  );
});
