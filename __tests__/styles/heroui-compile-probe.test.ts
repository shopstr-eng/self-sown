import { readFileSync } from "fs";
import path from "path";
import { createRequire } from "module";
import { compile } from "tailwindcss";

/**
 * Compile probe against the installed HeroUI + Tailwind combination: loads
 * the heroui() Tailwind plugin (the same call tailwind.config.ts makes) and
 * asserts its generated CSS still includes the semantic color utilities,
 * theme extensions, and base-layer variables the app relies on.
 *
 * Why this exists: tailwind-compile-probe.test.ts guards plain Tailwind
 * utilities, and check-globals-css.mjs guards the @source SCAN of HeroUI's
 * slot-class strings — but a scanned class only produces CSS if the plugin
 * still defines what it means. If a HeroUI upgrade (or a Tailwind change
 * that breaks its v3-style plugin compat) silently drops the plugin's theme,
 * every `bg-primary` / `text-foreground` / focus ring in the app stops
 * generating while builds and the existing probes stay green — the same
 * failure shape as the publish build that lost all HeroUI slot classes.
 *
 * Wiring: globals.css loads the plugin via `@config "../tailwind.config.ts"`,
 * which Tailwind loads through jiti — module-customization hooks the Jest
 * runtime forbids. Instead this test requires @heroui/react directly and
 * hands the plugin object to compile() through its `loadModule` hook via a
 * sentinel `@plugin` id: identical plugin code path, no jiti.
 *
 * The no-plugin counter-compilation proves the probe is not vacuous: none of
 * the asserted classes generate from core Tailwind alone (v4 dynamic
 * utilities like scale-85 DO, which is why they are not asserted here).
 */

// jsdom does not expose structuredClone, which Tailwind's plugin path calls
// when registering the heroui() config. The cloned value is the plugin's
// plain-data theme config (no functions — structuredClone would throw on
// those in Node too, and the real compile succeeds), so a JSON round trip is
// a faithful polyfill here.
if (typeof globalThis.structuredClone !== "function") {
  globalThis.structuredClone = <T,>(value: T): T =>
    JSON.parse(JSON.stringify(value)) as T;
}

const require2 = createRequire(__filename);
const { heroui } = require2("@heroui/react") as typeof import("@heroui/react");

async function loadStylesheet(
  id: string
): Promise<{ path: string; content: string; base: string }> {
  if (id !== "tailwindcss") {
    throw new Error(`heroui probe: unexpected @import "${id}"`);
  }
  const packageJson = require2.resolve("tailwindcss/package.json");
  const file = path.join(path.dirname(packageJson), "index.css");
  return {
    path: file,
    content: readFileSync(file, "utf8"),
    base: path.dirname(file),
  };
}

async function loadModule(id: string) {
  if (id !== "heroui-probe") {
    throw new Error(`heroui probe: unexpected @plugin "${id}"`);
  }
  return { path: id, base: path.join(__dirname, "../.."), module: heroui() };
}

// Extracts the `{ ... }` body of the `.name` rule (same brace-matching
// approach as tailwind-compile-probe). Returns null when the class generated
// no rule at all. Only used for plain utilities; variant/slot candidates are
// asserted by selector substring because Tailwind escapes them.
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

// Semantic color utilities the app uses everywhere (buttons, inputs, modals).
// Each only generates when the plugin's theme colors are registered.
const SEMANTIC_COLOR_CLASSES = [
  "bg-primary",
  "text-primary-foreground",
  "bg-background",
  "text-foreground",
  "bg-content1",
  "bg-default-100",
  "border-divider",
  "ring-focus",
] as const;

// Plugin theme extensions beyond colors: shadows, animations, opacities, and
// plugin-authored utilities. None of these exist in core Tailwind.
const PLUGIN_THEME_CLASSES = [
  "shadow-small",
  "animate-appearance-in",
  "opacity-disabled",
  "tap-highlight-transparent",
] as const;

// Slot-style candidates as HeroUI's component class strings actually spell
// them: core variant syntax wrapped around plugin-defined utilities. A
// HeroUI/Tailwind compat break that only kills variant composition (not the
// plain utilities) shows up here.
const SLOT_VARIANT_CLASSES = [
  "data-[focus-visible=true]:ring-focus",
  "data-[hover=true]:bg-default-100",
  "group-data-[filled-within=true]:text-foreground",
] as const;

const ALL_CANDIDATES = [
  ...SEMANTIC_COLOR_CLASSES,
  ...PLUGIN_THEME_CLASSES,
  ...SLOT_VARIANT_CLASSES,
];

describe("heroui compile probe", () => {
  let css = "";

  beforeAll(async () => {
    const compiler = await compile(
      '@import "tailwindcss"; @plugin "heroui-probe";',
      {
        base: path.join(__dirname, "../.."),
        loadStylesheet,
        loadModule,
      }
    );
    css = compiler.build([...ALL_CANDIDATES]);
    // Sanity: the probe must produce real output, or every assertion below
    // would silently fail against an empty string.
    expect(css).toContain("@layer utilities");
  }, 60_000);

  describe("semantic color utilities still generate", () => {
    it.each(SEMANTIC_COLOR_CLASSES)("generates a rule for .%s", (name) => {
      expect(ruleBody(css, name)).not.toBeNull();
    });

    it("bg-primary still resolves to the heroui primary variable", () => {
      expect(ruleBody(css, "bg-primary")).toContain(
        "background-color: hsl(var(--heroui-primary) / 1)"
      );
    });

    it("text-foreground still resolves to the heroui foreground variable", () => {
      expect(ruleBody(css, "text-foreground")).toContain(
        "color: hsl(var(--heroui-foreground) / 1)"
      );
    });
  });

  describe("plugin base layer still defines the theme variables", () => {
    it.each(["--heroui-primary:", "--heroui-foreground:", "--heroui-content1:"])(
      "defines %s as a real HSL triple",
      (variable) => {
        // The plugin's addBase must emit the variable definition with an
        // actual color value, not just reference it from utilities.
        expect(css).toMatch(new RegExp(`${variable} [\\d.]+ [\\d.]+% [\\d.]+%`));
      }
    );
  });

  describe("plugin theme extensions still generate", () => {
    it.each(PLUGIN_THEME_CLASSES)("generates a rule for .%s", (name) => {
      expect(ruleBody(css, name)).not.toBeNull();
    });

    it("animate-appearance-in still ships its keyframes", () => {
      expect(css).toContain("@keyframes appearance-in");
    });

    it("opacity-disabled still resolves to the heroui disabled-opacity variable", () => {
      expect(ruleBody(css, "opacity-disabled")).toContain(
        "opacity: var(--heroui-disabled-opacity)"
      );
    });
  });

  describe("component slot variant classes still generate", () => {
    it.each(SLOT_VARIANT_CLASSES)(
      "generates a rule for the slot class %s",
      (name) => {
        // Variant selectors are CSS-escaped in the output (e.g.
        // `.data-\[focus-visible\=true\]\:ring-focus[...]`), so assert on the
        // escaped literal. Our candidates only contain characters Tailwind
        // backslash-escapes: [ ] = :
        const selector = "." + name.replace(/[[\]:=]/g, "\\$&");
        expect(css).toContain(selector);
      }
    );
  });

  describe("the probe is not vacuous", () => {
    it("none of the asserted classes generate without the heroui plugin", async () => {
      // Guards against core Tailwind absorbing these names (making the
      // plugin assertions above meaningless) and proves this probe actually
      // exercises the plugin.
      const plain = await compile('@import "tailwindcss";', {
        base: path.join(__dirname, "../.."),
        loadStylesheet,
      });
      const plainCss = plain.build([
        ...SEMANTIC_COLOR_CLASSES,
        ...PLUGIN_THEME_CLASSES,
      ]);
      for (const name of [...SEMANTIC_COLOR_CLASSES, ...PLUGIN_THEME_CLASSES]) {
        expect(ruleBody(plainCss, name)).toBeNull();
      }
    }, 60_000);
  });
});
