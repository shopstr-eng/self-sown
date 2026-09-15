import { readFileSync } from "fs";
import path from "path";
import { createRequire } from "module";
import { compile } from "tailwindcss";

/**
 * Compile probe against the installed Tailwind: asserts the classes the
 * codebase actually relies on still generate CSS, and that the size-pinned
 * classes still emit their v3 sizes.
 *
 * Why this exists: scripts/check-theme-colors.mjs guards which class NAMES
 * are allowed, but nothing else verifies the installed Tailwind version still
 * generates the expected CSS for them. Tailwind upgrades have already done
 * both kinds of silent damage:
 *
 *   - dropped a family outright (v4 removed `*-opacity-*` — no CSS, no
 *     build error, the style just never applies), and
 *   - re-scaled a class (`shadow-sm`/`rounded-sm`/`blur-sm` are different
 *     sizes in v4; v4 `outline-none` removes the outline entirely instead of
 *     keeping it forced-colors-visible).
 *
 * The codebase is pinned to the v3 sizes via the v4 `*-xs` names (and
 * `outline-hidden`) and migrated to the canonical v4 utility names
 * (`shrink-*`, `grow`, `text-ellipsis`, `box-decoration-*`,
 * `bg-linear-to-*`). If a future Tailwind bump changes or drops any of
 * these, this test fails loudly instead of the site's look silently
 * changing.
 *
 * The probe compiles the default theme (`@import "tailwindcss"`) — enough
 * for every class asserted here; styles/globals.css defines no
 * `--radius-*` / `--shadow-*` / `--blur-*` overrides, so the default theme
 * is also the app's effective scale for these utilities.
 */

// `compile()` does not resolve `@import "tailwindcss"` on its own; give it a
// stylesheet loader. The bare id means the package's index.css — resolve it
// via `tailwindcss/package.json` and join the path manually instead of
// require.resolve("tailwindcss/index.css"), because under Jest the patched
// module resolution (next/jest) maps every `.css` import to its styleMock.js
// and compile() would parse that JS as CSS. tailwindcss/index.css is
// self-contained (no nested @imports), so this is the only id to handle.
const require2 = createRequire(__filename);
async function loadStylesheet(
  id: string
): Promise<{ path: string; content: string; base: string }> {
  if (id !== "tailwindcss") {
    throw new Error(`compile probe: unexpected @import "${id}"`);
  }
  const packageJson = require2.resolve("tailwindcss/package.json");
  const file = path.join(path.dirname(packageJson), "index.css");
  return {
    path: file,
    content: readFileSync(file, "utf8"),
    base: path.dirname(file),
  };
}

// Extracts the `{ ... }` body of the `.name` rule, brace-matching so nested
// blocks (`@supports` in bg-linear-to-*, `@media` in outline-hidden) stay in
// the body. Returns null when the class generated no rule at all.
function ruleBody(css: string, className: string): string | null {
  const start = css.indexOf(`.${className} {`);
  if (start === -1) return null;
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

const CANONICAL_V4_CLASSES = [
  "shrink",
  "shrink-0",
  "grow",
  "grow-0",
  "text-ellipsis",
  "box-decoration-slice",
  "box-decoration-clone",
  "bg-linear-to-r",
] as const;

const PINNED_SIZE_CLASSES = [
  "shadow-xs",
  "rounded-xs",
  "blur-xs",
  "backdrop-blur-xs",
  "outline-hidden",
] as const;

const BARE_ALIAS_CLASSES = ["shadow", "rounded", "blur"] as const;

const ALL_CANDIDATES = [
  ...CANONICAL_V4_CLASSES,
  ...PINNED_SIZE_CLASSES,
  ...BARE_ALIAS_CLASSES,
];

describe("tailwind compile probe", () => {
  let css = "";

  beforeAll(async () => {
    const compiler = await compile('@import "tailwindcss";', {
      base: path.join(__dirname, "../.."),
      loadStylesheet,
    });
    css = compiler.build([...ALL_CANDIDATES]);
    // Sanity: the probe must produce real output, or every assertion below
    // would silently fail against an empty string.
    expect(css).toContain("@layer utilities");
  }, 60_000);

  describe("canonical v4 utility names still generate CSS", () => {
    it.each(CANONICAL_V4_CLASSES)("generates a rule for .%s", (name) => {
      expect(ruleBody(css, name)).not.toBeNull();
    });

    it("shrink-0 / grow still set the flex properties", () => {
      expect(ruleBody(css, "shrink-0")).toContain("flex-shrink: 0");
      expect(ruleBody(css, "shrink")).toContain("flex-shrink: 1");
      expect(ruleBody(css, "grow")).toContain("flex-grow: 1");
      expect(ruleBody(css, "grow-0")).toContain("flex-grow: 0");
    });

    it("text-ellipsis still sets text-overflow", () => {
      expect(ruleBody(css, "text-ellipsis")).toContain(
        "text-overflow: ellipsis"
      );
    });

    it("box-decoration-* still sets box-decoration-break", () => {
      expect(ruleBody(css, "box-decoration-slice")).toContain(
        "box-decoration-break: slice"
      );
      expect(ruleBody(css, "box-decoration-clone")).toContain(
        "box-decoration-break: clone"
      );
    });

    it("bg-linear-to-* still sets a linear-gradient background", () => {
      const body = ruleBody(css, "bg-linear-to-r");
      expect(body).toContain("--tw-gradient-position: to right");
      expect(body).toContain("background-image: linear-gradient(");
    });
  });

  describe("pinned size classes still emit the v3 sizes", () => {
    it("shadow-xs keeps the v3 shadow-sm size", () => {
      expect(ruleBody(css, "shadow-xs")).toContain(
        "--tw-shadow: 0 1px 2px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.05))"
      );
    });

    it("rounded-xs keeps the v3 rounded-sm size (0.125rem)", () => {
      expect(ruleBody(css, "rounded-xs")).toContain(
        "border-radius: var(--radius-xs)"
      );
      expect(css).toContain("--radius-xs: 0.125rem");
    });

    it("blur-xs keeps the v3 blur-sm size (4px)", () => {
      expect(ruleBody(css, "blur-xs")).toContain(
        "--tw-blur: blur(var(--blur-xs))"
      );
      expect(css).toContain("--blur-xs: 4px");
    });

    it("backdrop-blur-xs keeps the v3 backdrop-blur-sm size (4px)", () => {
      expect(ruleBody(css, "backdrop-blur-xs")).toContain(
        "--tw-backdrop-blur: blur(var(--blur-xs))"
      );
      expect(css).toContain("--blur-xs: 4px");
    });

    it("outline-hidden keeps an invisible-but-forced-colors-safe outline", () => {
      const body = ruleBody(css, "outline-hidden");
      expect(body).toContain("outline-style: none");
      expect(body).toContain("forced-colors: active");
      expect(body).toContain("outline: 2px solid transparent");
      expect(body).toContain("outline-offset: 2px");
    });
  });

  describe("bare aliases still resolve to the v3 default sizes", () => {
    it("shadow keeps the v3 bare-shadow size", () => {
      const body = ruleBody(css, "shadow");
      expect(body).toContain("0 1px 3px 0");
      expect(body).toContain("0 1px 2px -1px");
    });

    it("rounded keeps the v3 bare-rounded size (0.25rem)", () => {
      expect(ruleBody(css, "rounded")).toContain("border-radius: 0.25rem");
    });

    it("blur keeps the v3 bare-blur size (8px)", () => {
      expect(ruleBody(css, "blur")).toContain("--tw-blur: blur(8px)");
    });
  });
});
