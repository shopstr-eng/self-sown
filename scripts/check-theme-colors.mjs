#!/usr/bin/env node
// Flags className tokens that reference a color Tailwind will never generate:
// a `bg-*` / `text-*` / `border-*` (etc.) class whose color token is defined
// neither by the Tailwind v4 default palette, nor by tailwind.config.ts
// `theme.extend.colors`, nor by HeroUI's semantic colors. Tailwind silently
// skips unknown color classes — no build error, the style just never applies —
// so a palette rename or cleanup leaves dead classes behind (a stale
// `hover:text-accent-white/10` survived for weeks in
// components/home/marketplace.tsx).
//
// Also flags v3-era `*-opacity-*` utilities (`bg-opacity-20`), which Tailwind
// v4 removed in favor of the slash opacity modifier (`bg-black/20`) — same
// failure mode: no build error, the style silently never applies.
//
// Exits non-zero and prints every offending `file:line  class-token` when any
// unknown color reference is found. Runnable by hand:
//
//   node scripts/check-theme-colors.mjs
//
// Wired into CI via __tests__/styles/theme-colors.test.ts and into the
// pre-commit staged checks (scripts/run-staged-checks.mjs).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "tailwind.config.ts");

// Keep in sync with the `@source` globs in styles/globals.css (the
// node_modules glob is intentionally not scanned — only our own sources).
const SCAN_DIRS = ["pages", "components", "utils", "app", "lib"];
const SCANNED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);

function fail(message) {
  process.stderr.write(`check-theme-colors: ${message}\n`);
  process.exit(1);
}

// --- Allowed color tokens ---------------------------------------------------

// Tailwind v4 default palette families (shades 50–950).
const DEFAULT_PALETTE_FAMILIES = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
];

const SPECIAL_COLORS = ["transparent", "current", "inherit", "black", "white"];

// Semantic colors added by the heroui() Tailwind plugin (each also generates
// shades plus a `-foreground` pair).
const HEROUI_COLORS = [
  "default",
  "primary",
  "secondary",
  "success",
  "warning",
  "danger",
  "foreground",
  "background",
  "content1",
  "content2",
  "content3",
  "content4",
  "divider",
  "focus",
  "overlay",
];

const VALID_SHADES = new Set([
  50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
]);

// Extracts the `{ ... }` block assigned to `key: {` in a config source,
// tracking brace depth. Returns null when the key is absent.
function extractBlock(source, key) {
  const match = source.match(new RegExp(`\\b${key}\\s*:\\s*{`));
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  return null;
}

// Extracts object-literal keys (`"primary-yellow":` or `black:`) from a block.
function extractKeys(block) {
  if (!block) return [];
  const keys = [];
  const re = /(?:["']([^"']+)["']|([A-Za-z_$][\w$-]*))\s*:/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    keys.push(m[1] ?? m[2]);
  }
  return keys;
}

const configSource = readFileSync(configPath, "utf8");
const configColors = extractKeys(extractBlock(configSource, "colors"));
const configBackgroundImages = extractKeys(
  extractBlock(configSource, "backgroundImage")
);
const configBoxShadows = extractKeys(extractBlock(configSource, "boxShadow"));

if (configColors.length === 0) {
  fail(
    `found no color keys in ${configPath} — refusing to scan against an ` +
      "empty palette (config parse broken?)"
  );
}

const ALLOWED_COLOR_NAMES = new Set([
  ...DEFAULT_PALETTE_FAMILIES,
  ...SPECIAL_COLORS,
  ...HEROUI_COLORS,
  ...configColors,
]);

// A color token is known when it is a palette name directly, a `<name>-<shade>`
// pair, or a HeroUI `<name>-foreground` pair.
function isKnownColor(name) {
  if (ALLOWED_COLOR_NAMES.has(name)) return true;
  const shade = name.match(/^(.+)-(\d{2,3})$/);
  if (
    shade &&
    ALLOWED_COLOR_NAMES.has(shade[1]) &&
    VALID_SHADES.has(Number(shade[2]))
  ) {
    return true;
  }
  const foreground = name.match(/^(.+)-foreground$/);
  if (foreground && ALLOWED_COLOR_NAMES.has(foreground[1])) return true;
  return false;
}

// --- Class-token parsing ----------------------------------------------------

// Color-taking utility prefixes, longest first so `ring-offset` wins over
// `ring` and `border-t` over `border`.
const COLOR_PREFIXES = [
  "text-shadow",
  "ring-offset",
  "border-t",
  "border-b",
  "border-l",
  "border-r",
  "border-x",
  "border-y",
  "border-s",
  "border-e",
  "bg",
  "text",
  "border",
  "ring",
  "shadow",
  "accent",
  "caret",
  "decoration",
  "outline",
  "fill",
  "stroke",
  "divide",
  "placeholder",
  "from",
  "via",
  "to",
];

// Same-prefix utilities whose argument is NOT a color (font sizes, shadow
// sizes, background keywords, border styles, ...). Anything listed here is
// ignored rather than flagged.
const FONT_SIZES = [
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "5xl",
  "6xl",
  "7xl",
  "8xl",
  "9xl",
  // HeroUI theme font sizes.
  "tiny",
  "small",
  "medium",
  "large",
];
const NON_COLOR_VALUES = {
  text: new Set([
    ...FONT_SIZES,
    "left",
    "center",
    "right",
    "justify",
    "start",
    "end",
    "ellipsis",
    "clip",
    "wrap",
    "nowrap",
    "balance",
    "pretty",
  ]),
  "text-shadow": new Set(["2xs", "xs", "sm", "md", "lg", "none"]),
  bg: new Set([
    "fixed",
    "local",
    "scroll",
    "bottom",
    "center",
    "left",
    "left-bottom",
    "left-top",
    "right",
    "right-bottom",
    "right-top",
    "top",
    "cover",
    "contain",
    "auto",
    "none",
    "repeat",
    "no-repeat",
    "repeat-x",
    "repeat-y",
    "repeat-round",
    "repeat-space",
    "origin-border",
    "origin-padding",
    "origin-content",
    "clip-border",
    "clip-padding",
    "clip-content",
    "clip-text",
    "radial",
    "conic",
    ...configBackgroundImages, // e.g. bg-grid-pattern
  ]),
  shadow: new Set([
    "2xs",
    "xs",
    "sm",
    "md",
    "lg",
    "xl",
    "2xl",
    "inner",
    "none",
    // HeroUI shadow sizes.
    "small",
    "medium",
    "large",
    ...configBoxShadows, // e.g. shadow-neo
  ]),
  ring: new Set(["inset"]),
  border: new Set([
    // Bare directional borders (`border-t`) set a width, not a color.
    "t",
    "b",
    "l",
    "r",
    "x",
    "y",
    "s",
    "e",
    // CSS value (`box-sizing: border-box`) inside <style> template strings.
    "box",
    "solid",
    "dashed",
    "dotted",
    "double",
    "hidden",
    "none",
    "collapse",
    "separate",
  ]),
  divide: new Set([
    "x",
    "y",
    "x-reverse",
    "y-reverse",
    "solid",
    "dashed",
    "dotted",
    "double",
    "none",
  ]),
  outline: new Set(["none", "hidden", "solid", "dashed", "dotted", "double"]),
  decoration: new Set([
    "solid",
    "double",
    "dotted",
    "dashed",
    "wavy",
    "auto",
    "from-font",
  ]),
  accent: new Set(["auto"]),
  fill: new Set(["none"]),
  stroke: new Set(["none"]),
};

const GRADIENT_DIRECTION_RE = /^gradient-to-(t|tr|r|br|b|bl|l|tl)$/;
const NUMERIC_RE = /^-?\d+(\.\d+)?%?$/;

// Candidate extraction: a class token must start after a boundary character
// (whitespace, quote, brace, ...) and end at one. This keeps CSS-in-JS
// properties (`text-align: center` — colon after), JSX text
// (`text-black">404`), and kebab-case identifiers out of the matches.
// Arbitrary values (`bg-[#fff]`, `bg-(--brand)`) can never match because
// `[`/`(` are excluded from the base's character set.
// `$` is excluded so template interpolation (`bg-white${...}`) can't match,
// and the trailing boundary deliberately excludes `:` so CSS-in-JS properties
// (`border-radius: 8px`, `text-align: center`) never match. `,`/`[` are
// excluded from the boundary set so bracketed arbitrary values
// (`transition-[background-color,border-color]`) don't match either.
const CLASS_CHARS = String.raw`[^\s"'\`{}()<>;,:$]`;
const BOUNDARY = String.raw`[\s"'\`{}()<>;]`;
const CANDIDATE_RE = new RegExp(
  `(?:^|${BOUNDARY})` +
    `((?:${CLASS_CHARS}+:)*!?` +
    `(?:${COLOR_PREFIXES.join("|")})-${CLASS_CHARS}+)` +
    `(?=$|${BOUNDARY})`,
  "g"
);

// Returns the unknown color name when the class token references one, or null
// when the token is fine / not a color class. The optional `reason` overrides
// the default "unknown color" explanation for tokens that are dead for a
// different reason (removed v3-era utilities).
function unknownColorIn(token) {
  const variantSplit = token.lastIndexOf(":");
  let base = variantSplit === -1 ? token : token.slice(variantSplit + 1);
  if (!base) return null;
  if (base.startsWith("!")) base = base.slice(1); // v3 important prefix
  if (base.endsWith("!")) base = base.slice(0, -1); // v4 important suffix

  const prefix = COLOR_PREFIXES.find(
    (p) => base.startsWith(`${p}-`) && base.length > p.length + 1
  );
  if (!prefix) return null;

  let rest = base.slice(prefix.length + 1);
  if (rest.includes("[") || rest.includes("(")) return null; // arbitrary value
  // Strip the opacity modifier: bg-black/50, text-red-500/[31%].
  rest = rest.split("/")[0];
  if (!rest) return null;
  if (NUMERIC_RE.test(rest)) return null; // widths, percentages (from-10%)
  // v3-era `*-opacity-*` utilities were removed in Tailwind v4; the slash
  // opacity modifier (`bg-black/20`) is the v4 form.
  const legacyOpacity = rest.match(/^opacity-(\d+)$/);
  if (legacyOpacity) {
    return {
      name: rest,
      reason:
        `v3-era utility removed in Tailwind v4 — use the slash opacity ` +
        `modifier instead (e.g. \`${prefix}-<color>/${legacyOpacity[1]}\`)`,
    };
  }
  if (prefix === "divide" && /^[xy]-\d+$/.test(rest)) return null; // divide-y-2
  if (NON_COLOR_VALUES[prefix]?.has(rest)) return null;
  if (prefix === "bg" && GRADIENT_DIRECTION_RE.test(rest)) return null;
  if (isKnownColor(rest)) return null;
  return { name: rest };
}

// --- Scan -------------------------------------------------------------------

function collectFiles(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, out);
    } else if (SCANNED_EXTENSIONS.has(path.extname(entry))) {
      out.push(full);
    }
  }
}

const files = [];
for (const dir of SCAN_DIRS) {
  const full = path.join(root, dir);
  try {
    statSync(full);
  } catch {
    continue; // optional dirs (app/, lib/) may not exist
  }
  collectFiles(full, files);
}

const COMMENT_LINE_RE = /^\s*(\/\/|--|\*|\/\*|\{\/\*|<!--)/;
const CONSOLE_LINE_RE = /^\s*console\.(log|error|warn|info|debug)\(/;

const violations = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    // Comment-only lines (incl. `--` SQL comments) and console.* log lines
    // carry prose ("from-address", "text-based") that looks like a class
    // token; neither is ever rendered as markup.
    if (COMMENT_LINE_RE.test(line) || CONSOLE_LINE_RE.test(line)) return;
    for (const match of line.matchAll(CANDIDATE_RE)) {
      const token = match[1];
      const hit = unknownColorIn(token);
      if (hit) {
        violations.push(
          `${path.relative(root, file)}:${index + 1}  ${token} ` +
            (hit.reason ?? `(unknown color "${hit.name}")`)
        );
      }
    }
  });
}

if (violations.length > 0) {
  process.stderr.write(
    `check-theme-colors: ${violations.length} class token(s) Tailwind will ` +
      "never generate (color not in the default palette, tailwind.config.ts " +
      "theme.extend.colors, or HeroUI semantic colors — or a v3-era utility " +
      "removed in Tailwind v4):\n" +
      violations.map((v) => `  ${v}`).join("\n") +
      "\n"
  );
  process.exit(1);
}

process.stdout.write(
  `check-theme-colors: ok (${files.length} files scanned)\n`
);
