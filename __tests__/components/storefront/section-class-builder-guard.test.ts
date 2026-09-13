/** @jest-environment node */

// Static guard: no storefront section file may hand-write conditional class
// concatenation inside a className template literal.
//
// section-hero.tsx once built its heading className as
// `font-bold${section.headingSize ? "" : "md:text-5xl"}` — missing the
// separating space — producing the dead class `font-boldmd:text-5xl` and
// silently stripping BOTH the bold weight and the responsive size (see the
// INVARIANT comment on joinClassNames in
// components/storefront/sections/section-elements.tsx, and the render-level
// sibling guard in section-heading-classes.test.tsx). The same one-character
// mistake in ANY inline conditional — `flex ${cond ? "md:flex-row" :
// "flex-col"}` on textAlign, imagePlacement, etc. — glues two Tailwind
// classes into a dead token the same way, whether the conditional's operands
// are string literals or variables.
//
// That bug class is now impossible by construction because every conditional
// className in a section file is composed through the shared joinClassNames
// helper (and the headingClassName/bodyClassName builders) in
// section-elements.tsx, which join tokens on explicit whitespace. But nothing
// structural stops a FUTURE section file from re-introducing a hand-written
// template literal with an inline conditional. This test source-scans the
// sections directory and fails on:
//
//   1. a `headingSize ?` / `bodySize ?` conditional string anywhere except
//      section-elements.tsx (the builders' own home),
//   2. ANY conditional operator (ternary, &&, ||) at the top level of a
//      `${...}` interpolation inside a className template literal —
//      regardless of operand shape. A static lookup-map index
//      (`${SIZE_CLASSES[size]}`), plain interpolation (`${align}`), or a
//      builder call (`${headingClassName(section, ...)}`) stays allowed, as
//      do operators nested inside a call's arguments (the function returns
//      one complete class string), and
//   3. the SAME conditional at the top level of a `${...}` interpolation in
//      ANY other template literal in the file — building the string in a
//      variable first (`const cls = `flex ${cond ? "md:flex-row" :
//      "flex-col"}`;` then `className={cls}`) is the identical bug one level
//      removed, and must not be a way around the className-prefix scan. The
//      whole-file walk uses the TypeScript parser, so comments and strings
//      can't smuggle or hide a template. The few legitimate non-class
//      template conditionals in these files (display text, CSS blocks, font
//      fallbacks) are named in NON_CLASS_TEMPLATE_ALLOWLIST below; the guard
//      fails on an unused allowlist entry so the list can't silently rot.
//
// Writing a new section with conditional classes? Compose them with
// joinClassNames("static tokens", cond ? "a" : "b") from section-elements.tsx
// — never `${cond ? "a" : "b"}` inside a template literal that feeds a
// className, whether written inline or assigned to a variable first.
//
// The same hand-written pattern also lived in storefront chrome components
// outside the sections folder (footer, email popup, layout, theme wrapper,
// preview frame/toggle), where a dropped space would strip styling from the
// storefront shell the same way. Those components now compose conditional
// classes through the same joinClassNames helper, and the generic
// className-template scan below also covers every top-level
// components/storefront/*.tsx file. (The legacy headingSize/bodySize check
// stays sections-scoped: those fields only exist on sections.)

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import ts from "typescript";

const SECTIONS_DIR = join(
  process.cwd(),
  "components",
  "storefront",
  "sections"
);

const STOREFRONT_DIR = join(process.cwd(), "components", "storefront");

// The shared builders legitimately branch on headingSize/bodySize. The
// allowlist exempts section-elements.tsx from ONLY the legacy size-field
// check below — the generic className-template scan still applies to it,
// because its JSX must compose conditional classes through joinClassNames
// like every other section file.
const SIZE_FIELD_ALLOWLIST = new Set([
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

// ---------------------------------------------------------------------------
// className-template scanner.
//
// Regexes over the raw template body can't tell a ternary's `:` from an
// object literal's `key: "value"` inside a function call, and quoting the
// operator's right-hand side misses variable operands (`${cond ? a : b}`).
// Instead we extract each `${...}` interpolation expression and look for
// conditional operators at its TOP nesting level only.
// ---------------------------------------------------------------------------

// Returns the index just past the closing quote of the string starting at
// `start` (source[start] is the quote char). Handles backslash escapes; for
// backtick templates it also skips nested ${...} interpolations.
function skipString(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && ch === "$" && source[i + 1] === "{") {
      i = skipInterpolation(source, i + 2);
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return i;
}

// Returns the index just past the `}` closing the interpolation whose `{` is
// at start - 1 (i.e. start is the first character of the expression).
function skipInterpolation(source: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return i;
}

// Extracts the expression text of every ${...} interpolation in every
// className={`...`} template literal in the source.
function classNameInterpolations(source: string): string[] {
  const out: string[] = [];
  const re = /className=\{\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let i = m.index + m[0].length; // first char after the opening backtick
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        i++;
        break; // end of this template literal
      }
      if (ch === "$" && source[i + 1] === "{") {
        const end = skipInterpolation(source, i + 2);
        out.push(source.slice(i + 2, end - 1));
        i = end;
        continue;
      }
      i++;
    }
    re.lastIndex = i;
  }
  return out;
}

// Strips parentheses that wrap the WHOLE expression ((cond ? a : b) →
// cond ? a : b), repeatedly. Parens that belong to a call or group only part
// of the expression (foo(...), (a) + "x") are left alone.
function unwrapRootParens(expr: string): string {
  let e = expr.trim();
  for (;;) {
    if (!e.startsWith("(")) return e;
    let depth = 0;
    let wraps = false;
    for (let i = 0; i < e.length; i++) {
      const ch = e[i];
      if (ch === "'" || ch === '"' || ch === "`") {
        i = skipString(e, i) - 1;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          wraps = i === e.length - 1;
          break;
        }
      }
    }
    if (!wraps) return e;
    e = e.slice(1, -1).trim();
  }
}

// True when the expression branches at its root: a ternary `?` (excluding
// `?.` optional chaining and `??` nullish coalescing, both skipped as
// two-char operators), a logical &&, or a logical ||. Root-wrapping parens
// are unwrapped first so `(cond ? a : b)` can't smuggle a conditional past
// the scan. Operators nested inside call arguments, object literals, index
// brackets, or strings do not count — a call like headingClassName(...) or
// choose({ key: "value" }) returns one complete class string.
function hasTopLevelConditional(expr: string): boolean {
  const e = unwrapRootParens(expr);
  let depth = 0;
  let i = 0;
  while (i < e.length) {
    const ch = e[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(e, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0) {
      if (ch === "?" && (e[i + 1] === "." || e[i + 1] === "?")) {
        i += 2; // ?. or ?? — not a conditional branch
        continue;
      }
      if (ch === "?") return true;
      if (ch === "&" && e[i + 1] === "&") return true;
      if (ch === "|" && e[i + 1] === "|") return true;
    }
    i++;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Whole-file template-literal scanner.
//
// classNameInterpolations only sees templates that start immediately after
// `className={``. The same merged-class bug can hide one level removed —
// build the string in a variable (`const cls = `flex ${cond ? "md:flex-row" :
// "flex-col"}`;`) and pass `className={cls}` — so this walk parses the file
// with the TypeScript compiler and extracts the expression text of every
// ${...} interpolation of every template literal, wherever the template
// appears (variable initializer, call argument, JSX attribute, …). A real
// parser keeps comments and quoted strings from being mistaken for code (the
// joinClassNames INVARIANT comment itself contains an example template), and
// tagged/nested templates are covered for free.
// ---------------------------------------------------------------------------

// Expression text of every template-literal interpolation in the file.
function templateLiteralExpressions(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        out.push(span.expression.getText(sf));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Legitimate non-class template conditionals the whole-file scan must not
// flag. Each entry matches when `snippet` (whitespace-normalized) is a
// substring of the offending interpolation's normalized text. Adding a new
// legitimate use? Prefer joinClassNames for anything that feeds a className —
// this list is ONLY for conditionals that provably build display text, CSS
// blocks, keys, or other non-class strings. Unused entries fail the guard.
const NON_CLASS_TEMPLATE_ALLOWLIST: Array<{
  file: string;
  snippet: string;
  reason: string;
}> = [
  // Review emoji rendered as Chip text, never a class.
  {
    file: "components/storefront/sections/section-reviews.tsx",
    snippet: 'value === "1" ? "👍" : "👎"',
    reason: "thumbs-up/down emoji in Chip label text",
  },
  {
    file: "components/storefront/sections/section-product-reviews.tsx",
    snippet: 'value === "1" ? "👍" : "👎"',
    reason: "thumbs-up/down emoji in Chip label text",
  },
  // Shipping-cost suffix appended to display text; the branch is itself a
  // text template, not a class token.
  {
    file: "components/storefront/sections/section-product-shipping-returns.tsx",
    snippet: "product.shippingCost ? `: ${product.shippingCost} ${product.currency}` :",
    reason: "shipping-cost suffix in shipping-returns display text",
  },
  // React element key for bold/emphasis inline nodes.
  {
    file: "components/storefront/storefront-policy-page.tsx",
    snippet: 'isBold ? "b" : "e"',
    reason: "react key suffix for inline bold/emphasis nodes",
  },
  // Uploaded-font family-name fallbacks inside @font-face CSS text.
  ...[
    "components/storefront/storefront-layout.tsx",
    "components/storefront/storefront-preview-frame.tsx",
    "components/storefront/storefront-theme-wrapper.tsx",
  ].flatMap((file) => [
    {
      file,
      snippet: '|| "CustomHeading"',
      reason: "custom heading-font family-name fallback in @font-face CSS text",
    },
    {
      file,
      snippet: '|| "CustomBody"',
      reason: "custom body-font family-name fallback in @font-face CSS text",
    },
  ]),
  // Neo-shadow CSS overrides: the ternary picks between large blocks of CSS
  // text (its operands are templates of selectors, not class tokens).
  {
    file: "components/storefront/storefront-layout.tsx",
    snippet: "storefront.neoShadows ? `",
    reason: "neo-shadow CSS override block in <style> text",
  },
  {
    file: "components/storefront/storefront-theme-wrapper.tsx",
    snippet: "storefront?.neoShadows ? `",
    reason: "neo-shadow CSS override block in <style> text",
  },
  // Currency fallback for the featured product's price display.
  {
    file: "components/storefront/storefront-product-grid.tsx",
    snippet: 'featuredProduct.currency?.toUpperCase() || "USD"',
    reason: "currency-code fallback in price display text",
  },
  // Pluralization and restore-status suffixes in wallet message text.
  {
    file: "components/storefront/storefront-wallet.tsx",
    snippet: 'skippedCount === 1 ? "" : "s"',
    reason: "pluralization suffix in wallet restore message",
  },
  {
    file: "components/storefront/storefront-wallet.tsx",
    snippet: 'restoredCount === 1 ? "" : "s"',
    reason: "pluralization suffix in wallet restore message",
  },
  {
    file: "components/storefront/storefront-wallet.tsx",
    snippet: "skippedCount > 0 ? ` ${skippedCount} skipped",
    reason: "skipped-mint suffix in wallet restore message",
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

// Top-level storefront chrome components (footer, layout, email popup, theme
// wrapper, previews, …) get ONLY the generic className-template scan — the
// legacy headingSize/bodySize check is sections-specific. Subdirectories
// (sections/ and anything added later) are intentionally not walked here:
// sections/ is covered by collectSectionSources above.
function collectStorefrontChromeSources(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".tsx"))
    .filter((entry) => statSync(join(dir, entry)).isFile())
    .map((entry) => join(dir, entry));
}

describe("storefront section class-builder guard", () => {
  const scannedFiles = collectSectionSources(SECTIONS_DIR);
  const scannedChromeFiles = collectStorefrontChromeSources(STOREFRONT_DIR);
  const offenders: Array<{ file: string; label: string }> = [];

  for (const file of scannedFiles) {
    const rel = relative(process.cwd(), file);
    const source = readFileSync(file, "utf8");

    // Legacy size-field check: allowlisted for the builders' own home only.
    if (!SIZE_FIELD_ALLOWLIST.has(rel)) {
      for (const { re, label } of FORBIDDEN_PATTERNS) {
        if (re.test(source)) offenders.push({ file: rel, label });
      }
    }
  }

  // Generic class-template check: NO file is exempt — section-elements.tsx
  // composes its JSX conditional classes through joinClassNames too, and the
  // storefront chrome components outside sections/ are held to the same bar.
  for (const file of [...scannedFiles, ...scannedChromeFiles]) {
    const rel = relative(process.cwd(), file);
    const source = readFileSync(file, "utf8");

    for (const expr of classNameInterpolations(source)) {
      if (hasTopLevelConditional(expr)) {
        offenders.push({
          file: rel,
          label: `conditional operator in className template interpolation \`\${${expr.trim()}}\``,
        });
      }
    }
  }

  // Whole-file template check: the identical bug one level removed — build
  // the string in a variable first (`const cls = `flex ${cond ? "md:flex-row"
  // : "flex-col"}`;`) and pass className={cls} — must not slip past the
  // className-prefix scan above. Every template literal in these files is
  // walked; a top-level conditional in any interpolation is flagged unless
  // it is a named non-class use in NON_CLASS_TEMPLATE_ALLOWLIST.
  const usedAllowlistEntries = new Set<number>();
  for (const file of [...scannedFiles, ...scannedChromeFiles]) {
    const rel = relative(process.cwd(), file);
    const source = readFileSync(file, "utf8");

    for (const expr of templateLiteralExpressions(source, rel)) {
      if (!hasTopLevelConditional(expr)) continue;
      const normalized = normalizeWhitespace(expr);
      const allowIdx = NON_CLASS_TEMPLATE_ALLOWLIST.findIndex(
        (entry) =>
          entry.file === rel && normalized.includes(normalizeWhitespace(entry.snippet))
      );
      if (allowIdx !== -1) {
        usedAllowlistEntries.add(allowIdx);
        continue;
      }
      offenders.push({
        file: rel,
        label: `conditional operator in template literal interpolation \`\${${expr.trim()}}\` (compose classNames with joinClassNames)`,
      });
    }
  }

  it("finds no hand-written headingSize/bodySize conditional class suffixes outside section-elements.tsx", () => {
    const sizeOffenders = offenders.filter((o) =>
      o.label.includes("conditional string suffix")
    );
    expect(sizeOffenders).toEqual([]);
  });

  it("finds no inline conditional class concatenation in any section className template literal", () => {
    const templateOffenders = offenders.filter((o) =>
      o.label.includes("className template interpolation")
    );
    expect(templateOffenders).toEqual([]);
  });

  it("finds no conditional class-building template literal, even when assigned to a variable before className", () => {
    const wholeFileOffenders = offenders.filter((o) =>
      o.label.includes("conditional operator in template literal interpolation")
    );
    expect(wholeFileOffenders).toEqual([]);
  });

  it("keeps the non-class template allowlist tight (no unused entries)", () => {
    // An entry whose expression was edited or deleted would silently rot into
    // a loophole for anything matching its snippet — fail loudly instead.
    const unused = NON_CLASS_TEMPLATE_ALLOWLIST.filter(
      (_, idx) => !usedAllowlistEntries.has(idx)
    );
    expect(unused).toEqual([]);
  });

  it("scans every section file (guard against a silently broken walk)", () => {
    // If the directory or the filename convention changes, this guard must
    // fail loudly instead of silently scanning nothing.
    expect(scannedFiles.length).toBeGreaterThanOrEqual(20);
    expect(scannedFiles).toContain(join(SECTIONS_DIR, "section-elements.tsx"));
  });

  it("scans the storefront chrome components outside sections/ (guard against a silently broken walk)", () => {
    // Same loud-failure contract for the top-level components/storefront/*.tsx
    // scan: the chrome files this guard was extended for must be present.
    expect(scannedChromeFiles.length).toBeGreaterThanOrEqual(15);
    for (const expected of [
      "storefront-footer.tsx",
      "storefront-email-popup.tsx",
      "storefront-layout.tsx",
      "storefront-theme-wrapper.tsx",
      "preview-device-toggle.tsx",
    ]) {
      expect(scannedChromeFiles).toContain(join(STOREFRONT_DIR, expected));
    }
  });

  it("detects inline conditionals in className templates whatever the operand shape (guard self-check)", () => {
    // The scanner must bite on every bug shape it exists to catch — the
    // original heading-size regression, other fields' conditionals, and
    // variable (non-literal) operands of ternary/&&/||.
    const forbidden = [
      'className={`font-bold${section.headingSize ? "" : "md:text-5xl"}`}',
      'className={`flex ${cond ? "md:flex-row" : "flex-col"}`}',
      "className={`base${enabled ? activeClass : inactiveClass}`}",
      'className={`border-2 ${\n  value === "1" ? "bg-green-400" : "bg-red-400"\n}`}',
      'className={`flex gap-3 ${cond && "md:flex-row-reverse"}`}',
      "className={`flex gap-3 ${enabled && activeClass}`}",
      'className={`flex gap-3 ${ALIGN_CLASSES[align] || "justify-start"}`}',
      "className={`base ${override || defaultClass}`}",
      // Root-wrapping parens must not smuggle a conditional past the scan.
      "className={`base${(cond ? active : inactive)}`}",
      "className={`base ${(cond && activeClass)}`}",
      "className={`base ${((override || defaultClass))}`}",
    ];
    for (const sample of forbidden) {
      const exprs = classNameInterpolations(sample);
      expect(exprs.length).toBeGreaterThan(0);
      expect(exprs.some(hasTopLevelConditional)).toBe(true);
    }
    // Static lookup-map indexes, plain interpolations, builder calls, and
    // object-literal call arguments stay allowed.
    const allowed = [
      "className={`mx-auto ${SIZE_CLASSES[width]} ${align}`}",
      "className={`${inputClass} resize-y`}",
      'className={`font-bold ${headingClassName(section, "text-3xl", "md:text-5xl")}`}',
      'className={`${choose({ key: "value" })} w-full`}',
      'className={`${list.map((x) => x.cls).join(" ")} w-full`}',
      // Optional chaining and nullish coalescing are fallbacks/lookahead, not
      // conditional branches — they can't glue tokens mid-expression.
      "className={`mx-auto ${section.headingSize ?? fallbackSize}`}",
      "className={`mx-auto ${section.theme?.sizeClass}`}",
    ];
    for (const sample of allowed) {
      const exprs = classNameInterpolations(sample);
      expect(exprs.length).toBeGreaterThan(0);
      expect(exprs.some(hasTopLevelConditional)).toBe(false);
    }
  });

  it("detects conditionals in templates assigned to variables before className (guard self-check)", () => {
    // The bug shape this layer exists to catch: the className-prefix scan is
    // blind to it, the whole-file walk must not be.
    const variableAssigned = [
      'const cls = `flex ${cond ? "md:flex-row" : "flex-col"}`;',
      "<div className={cls} />",
    ].join("\n");
    expect(
      templateLiteralExpressions(variableAssigned, "sample.tsx").some(
        hasTopLevelConditional
      )
    ).toBe(true);
    // Every operand shape the inline scan catches, one level removed.
    for (const expr of [
      'const cls = `font-bold${section.headingSize ? "" : "md:text-5xl"}`;',
      "const cls = `base${enabled ? activeClass : inactiveClass}`;",
      'const cls = `flex gap-3 ${cond && "md:flex-row-reverse"}`;',
      "const cls = `base ${override || defaultClass}`;",
    ]) {
      expect(
        templateLiteralExpressions(expr, "sample.tsx").some(
          hasTopLevelConditional
        )
      ).toBe(true);
    }
    // Legitimate non-class uses stay allowed without an allowlist entry when
    // their conditional is nested inside a call's arguments.
    const nested = "const label = `${items.map((x) => (x.on ? 1 : 0)).join(\",\")}`;";
    expect(
      templateLiteralExpressions(nested, "sample.tsx").some(
        hasTopLevelConditional
      )
    ).toBe(false);
  });

  it("does not mistake comments or quoted strings for template literals (guard self-check)", () => {
    // The joinClassNames INVARIANT comment itself carries an example
    // template; a text walk that ignores comments would flag the very file
    // that defines the fix.
    const commented = [
      '// const cls = `flex ${cond ? "md:flex-row" : "flex-col"}`;',
      '/* const cls = `flex ${cond ? "md:flex-row" : "flex-col"}`; */',
      'const note = "see `flex ${cond ? "a" : "b"}` for the bad shape";',
    ].join("\n");
    expect(templateLiteralExpressions(commented, "sample.tsx")).toEqual([]);
  });

  it("applies the generic class-template scan to section-elements.tsx too", () => {
    // The allowlist must exempt the builders' home from ONLY the legacy
    // size-field check. If someone extends it to skip the generic scan, a
    // conditional class template in section-elements.tsx (e.g. the left/right
    // image-placement layout) would go back to being uncaught.
    const source = readFileSync(
      join(SECTIONS_DIR, "section-elements.tsx"),
      "utf8"
    );
    const exprs = classNameInterpolations(source);
    // Sanity: the file has className template interpolations the scan can see.
    expect(exprs.length).toBeGreaterThan(0);
    // And none of them branch at the top level — i.e. the generic scan
    // genuinely covers the file rather than skipping it.
    expect(exprs.some(hasTopLevelConditional)).toBe(false);
  });
});
