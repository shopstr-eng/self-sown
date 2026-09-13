/** @jest-environment node */

// Static guard: no storefront section file may hand-write a conditional class
// suffix for heading/body sizing.
//
// section-hero.tsx once built its heading className as
// `font-bold${section.headingSize ? "" : "md:text-5xl"}` — missing the
// separating space — producing the dead class `font-boldmd:text-5xl` and
// silently stripping BOTH the bold weight and the responsive size (see the
// INVARIANT comment on joinClassNames in
// components/storefront/sections/section-elements.tsx, and the render-level
// sibling guard in section-heading-classes.test.tsx).
//
// That bug class is now impossible by construction because every section
// composes heading/body classes through the shared
// headingClassName/bodyClassName builders in section-elements.tsx, which join
// tokens on explicit whitespace. But nothing structural stops a FUTURE
// section file from re-introducing a hand-written template literal with an
// inline conditional suffix. This test source-scans the sections directory
// and fails on the `headingSize ?` / `bodySize ?` conditional pattern
// anywhere except section-elements.tsx (the builders' own home).
//
// Writing a new section with a sized heading or body? Call
// headingClassName(section, baseSize, legacyResponsiveSize) or
// bodyClassName(section, baseSize, legacyResponsiveSize) from
// section-elements.tsx — never `${section.headingSize ? "" : "..."}`.

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SECTIONS_DIR = join(
  process.cwd(),
  "components",
  "storefront",
  "sections"
);

// The shared builders legitimately branch on headingSize/bodySize.
const ALLOWLIST = new Set([
  "components/storefront/sections/section-elements.tsx",
]);

// A ternary on the size fields producing a string literal inside a section
// file can only be hand-rolled class concatenation — the builders own that
// branch. Requiring a quote/backtick after the `?` keeps optional chaining
// (`headingSize?.`) and nullish coalescing (`headingSize ??`) from matching.
const FORBIDDEN_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /\bheadingSize\s*\?\s*["'`]/,
    label: "conditional string suffix on section.headingSize",
  },
  {
    re: /\bbodySize\s*\?\s*["'`]/,
    label: "conditional string suffix on section.bodySize",
  },
];

function collectSectionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSectionSources(full, out);
      continue;
    }
    if (/^section-.*\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

describe("storefront section class-builder guard", () => {
  const scannedFiles = collectSectionSources(SECTIONS_DIR);
  const offenders: Array<{ file: string; label: string }> = [];

  for (const file of scannedFiles) {
    const rel = relative(process.cwd(), file);
    if (ALLOWLIST.has(rel)) continue;
    const source = readFileSync(file, "utf8");
    for (const { re, label } of FORBIDDEN_PATTERNS) {
      if (re.test(source)) offenders.push({ file: rel, label });
    }
  }

  it("finds no hand-written headingSize/bodySize conditional class suffixes outside section-elements.tsx", () => {
    expect(offenders).toEqual([]);
  });

  it("scans every section file (guard against a silently broken walk)", () => {
    // If the directory or the filename convention changes, this guard must
    // fail loudly instead of silently scanning nothing.
    expect(scannedFiles.length).toBeGreaterThanOrEqual(20);
    expect(scannedFiles).toContain(
      join(SECTIONS_DIR, "section-elements.tsx")
    );
  });
});
