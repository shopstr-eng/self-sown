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
//      fails on an unused allowlist entry so the list can't silently rot, and
//   4. plain `+` string concatenation whose operands include a conditional
//      with a string-literal branch — `className={"font-bold" + (cond ?
//      " md:text-5xl" : "")}` or `const cls = "flex " + (cond ? "md:flex-row"
//      : "flex-col")` glue the same dead token (font-boldmd:text-5xl) when
//      one branch drops its leading space. Same TypeScript-parser walk as
//      (3), same NON_CLASS_CONCAT_ALLOWLIST contract for the few legitimate
//      non-class concats, and
//   5. array-join and String.prototype.concat assembly —
//      ["font-bold", cond ? "md:text-5xl" : ""].join("") or
//      "font-bold".concat(cond ? " md:text-5xl" : ""). A `.join(" ")` (any
//      separator containing whitespace) composes tokens safely, exactly like
//      joinClassNames, so only a whitespace-FREE separator — `.join("")`,
//      `.join(",")`, or a missing separator (which joins on ",") — is
//      flagged, and only when the joined subtree branches on a conditional
//      alongside a string literal. `.concat(` never supplies a separator, so
//      it is flagged whenever its subtree pairs a conditional with a string
//      literal: a branch that drops its leading space glues the same dead
//      token as the '+' scan. Same TypeScript-parser walk, same
//      NON_CLASS_JOIN_CONCAT_ALLOWLIST contract.
//
// Writing a new section with conditional classes? Compose them with
// joinClassNames("static tokens", cond ? "a" : "b") from section-elements.tsx
// — never `${cond ? "a" : "b"}` inside a template literal that feeds a
// className, never "a" + (cond ? " b" : "") concatenation, and never
// [...].join("") or "a".concat(cond ? " b" : "") assembly, whether written
// inline or assigned to a variable first.
//
// The same hand-written pattern also lived in storefront chrome components
// outside the sections folder (footer, email popup, layout, theme wrapper,
// preview frame/toggle), where a dropped space would strip styling from the
// storefront shell the same way. Those components now compose conditional
// classes through the same joinClassNames helper, and the generic
// className-template scan below also covers every top-level
// components/storefront/*.tsx file. (The legacy headingSize/bodySize check
// stays sections-scoped: those fields only exist on sections.)
//
// The bug class is not storefront-specific, so the three generic scans below
// also cover a scoped list of the next-riskiest NON-storefront surfaces
// (SCOPED_NON_STOREFRONT_FILES): the checkout/invoice cards and the seller
// dashboard components, where the same dropped space would silently strip
// styling from payment buttons, form borders, and order-status badges. Those
// files compose conditional classes through the same joinClassNames helper,
// now shared from utils/class-names.ts (re-exported by section-elements.tsx),
// and their few legitimate non-class template/concat conditionals (buyer and
// seller message bodies, shipping-address fallbacks, spec-descriptor text,
// emoji labels) are named in the same NON_CLASS_TEMPLATE_ALLOWLIST /
// NON_CLASS_CONCAT_ALLOWLIST lists with the same unused-entry contract.

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

// Next-riskiest NON-storefront surfaces held to the same three generic scans
// (className templates, whole-file templates, '+' concatenation): the
// checkout/invoice cards a buyer pays through and the seller dashboard
// components. Their legitimate non-class conditionals are allowlisted below;
// everything class-feeding composes through joinClassNames from
// utils/class-names.ts. Paths are workspace-relative; the coverage test at
// the bottom fails loudly if one is renamed or dropped from the scan.
const SCOPED_NON_STOREFRONT_FILES = [
  "components/product-invoice-card.tsx",
  "components/cart-invoice-card.tsx",
  "components/utility-components/checkout-card.tsx",
  "components/messages/orders-dashboard.tsx",
  "components/messages/contacts-dashboard.tsx",
  "components/messages/email-stats-dashboard.tsx",
  "components/messages/subscription-management.tsx",
];

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

// ---------------------------------------------------------------------------
// Whole-file '+' string-concatenation scanner.
//
// Neither template scan above sees plain concatenation: className={"font-bold"
// + (cond ? " md:text-5xl" : "")} or const cls = "flex " + (cond ?
// "md:flex-row" : "flex-col") glue the identical dead token when a branch
// drops its leading space. This walk flags every BinaryExpression '+' chain
// (only the chain's root is inspected, so nested links don't double-report)
// whose operands include a conditional — ternary, &&, or || — when the chain
// provably builds a string: a string literal or template literal anywhere
// among its operands (including inside the conditional's branches). The
// conditional's branch shape does NOT matter — "flex " + (cond ? rowClass :
// colClass) composes conditional classes by hand exactly like the template
// scans forbid, whatever the operands are. Parentheses are unwrapped, so
// ("a" + ((cond ? "b" : "c"))) can't smuggle the shape past the scan. Chains
// with a conditional but no string literal anywhere (numeric or
// unknown-typed operands) stay out of scope — they can't be audited
// statically and are display/business logic, not class composition.
// ---------------------------------------------------------------------------

function unwrapParens(node: ts.Expression): ts.Expression {
  let n = node;
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
}

// True when the operand branches at its root: ternary, &&, or ||. Branch
// shape is irrelevant — the whole point is that conditional class composition
// belongs in joinClassNames regardless of operand shape.
function isConditionalOperand(node: ts.Expression): boolean {
  const n = unwrapParens(node);
  return (
    ts.isConditionalExpression(n) ||
    (ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarToken))
  );
}

// True when the operand subtree contains a string literal or template
// literal anywhere — as the operand itself, inside a conditional's branches,
// or in a nested expression. That's what proves the '+' chain is string
// concatenation rather than arithmetic.
function containsStringLiteral(node: ts.Node): boolean {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node)
  ) {
    return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsStringLiteral(child)) found = true;
  });
  return found;
}

// Source text of every string-building '+' concatenation chain in the file
// whose operands include a conditional.
function stringConcatConditionals(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      // Only inspect the chain's root: `"a" + (c ? "b" : "") + other` is one
      // chain, reported once — its inner links have a '+' parent and skip.
      !(
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      )
    ) {
      const operands: ts.Expression[] = [];
      const flatten = (n: ts.Expression): void => {
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.PlusToken
        ) {
          flatten(n.left);
          flatten(n.right);
        } else {
          operands.push(n);
        }
      };
      flatten(node);
      if (
        operands.some(isConditionalOperand) &&
        operands.some(containsStringLiteral)
      ) {
        out.push(node.getText(sf));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------------------
// Whole-file array-join / String.concat scanner.
//
// The last two hand-written shapes the template and '+' scans are both blind
// to: building the class string via an array — ["font-bold",
// cond ? "md:text-5xl" : ""].join("") — or via String.prototype.concat —
// "font-bold".concat(cond ? " md:text-5xl" : ""). A `.join(" ")` (any
// separator containing whitespace) composes tokens safely the same way
// joinClassNames does, so a join is flagged only when its separator is a
// string literal with NO whitespace (or is missing entirely — `.join()`
// joins on ","), and only when the receiver subtree contains a conditional
// (ternary, &&, or ||) alongside a string literal, proving conditional
// string assembly rather than numeric/business-logic joining. `.concat(`
// never supplies a separator, so it is flagged whenever its receiver or
// arguments pair a conditional with a string literal. A non-literal
// separator variable stays out of scope — it can't be audited statically.
// ---------------------------------------------------------------------------

// True when the subtree branches anywhere: ternary, &&, or ||. Used by the
// join/concat scan, where the conditional can sit inside an array element or
// a map/filter callback rather than at the chain root.
function containsConditional(node: ts.Node): boolean {
  if (ts.isConditionalExpression(node)) return true;
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsConditional(child)) found = true;
  });
  return found;
}

// Source text of every unsafe array-join or String.concat string assembly in
// the file: a .join() whose separator has no whitespace, or any .concat(),
// whose subtree contains both a conditional and a string literal.
function joinConcatConditionals(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      let unsafe = false;
      if (method === "join") {
        const sep = node.arguments[0];
        // .join() with no argument joins on "," — no whitespace either way.
        // A non-literal separator can't be audited statically; skip it.
        const noWhitespaceSeparator =
          sep === undefined ||
          ((ts.isStringLiteral(sep) ||
            ts.isNoSubstitutionTemplateLiteral(sep)) &&
            !/\s/.test(sep.text));
        unsafe =
          noWhitespaceSeparator &&
          containsConditional(receiver) &&
          containsStringLiteral(receiver);
      } else if (method === "concat") {
        unsafe =
          (containsConditional(receiver) ||
            node.arguments.some(containsConditional)) &&
          (containsStringLiteral(receiver) ||
            node.arguments.some(containsStringLiteral));
      }
      if (unsafe) out.push(node.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
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
  // ---- Scoped non-storefront surfaces (SCOPED_NON_STOREFRONT_FILES) ----
  // Shipping-address unit suffix + field fallbacks in order display text
  // (components/product-invoice-card.tsx).
  {
    file: "components/product-invoice-card.tsx",
    snippet: "paymentData.shippingUnitNo ? `",
    reason: "unit-number suffix in shipping-address display text",
  },
  ...["shippingCity", "shippingState", "shippingPostalCode", "shippingCountry"].map(
    (field) => ({
      file: "components/product-invoice-card.tsx",
      snippet: `paymentData.${field} || ""`,
      reason: "address-field fallback in shipping-address display text",
    })
  ),
  // Spec-descriptor suffixes in order display text (each appears in both the
  // buyer and seller summary builders). The selectedVariant entry must stay
  // BEFORE the bare variantLabel entry: the selectedVariant expression
  // embeds `variantLabel || "Option"`, and first-match-wins would otherwise
  // leave this entry unused and fail the guard.
  {
    file: "components/product-invoice-card.tsx",
    snippet: "selectedSize ? `Size:",
    reason: "size descriptor in order display text",
  },
  {
    file: "components/product-invoice-card.tsx",
    snippet: "selectedVolume ? ` Volume:",
    reason: "volume descriptor in order display text",
  },
  {
    file: "components/product-invoice-card.tsx",
    snippet: "selectedWeight ? ` Weight:",
    reason: "weight descriptor in order display text",
  },
  {
    file: "components/product-invoice-card.tsx",
    snippet: "selectedVariant ? `",
    reason: "variant descriptor in order display text",
  },
  {
    file: "components/product-invoice-card.tsx",
    snippet: 'variantLabel || "Option"',
    reason: "variant-label fallback in order display text",
  },
  // Same address fallbacks in the cart card — against paymentData AND the
  // per-seller `data` form object (components/cart-invoice-card.tsx).
  {
    file: "components/cart-invoice-card.tsx",
    snippet: "paymentData.shippingUnitNo ? `",
    reason: "unit-number suffix in shipping-address display text",
  },
  ...["shippingCity", "shippingState", "shippingPostalCode", "shippingCountry"].map(
    (field) => ({
      file: "components/cart-invoice-card.tsx",
      snippet: `paymentData.${field} || ""`,
      reason: "address-field fallback in shipping-address display text",
    })
  ),
  {
    file: "components/cart-invoice-card.tsx",
    snippet: "data.shippingUnitNo ? `",
    reason: "unit-number suffix in shipping-address display text",
  },
  ...["shippingCity", "shippingState", "shippingPostalCode", "shippingCountry"].map(
    (field) => ({
      file: "components/cart-invoice-card.tsx",
      snippet: `data.${field} || ""`,
      reason: "address-field fallback in shipping-address display text",
    })
  ),
  {
    file: "components/cart-invoice-card.tsx",
    snippet: "shippingData.Unit ? `",
    reason: "unit suffix in confirmation-address display text",
  },
  {
    file: "components/cart-invoice-card.tsx",
    snippet: 'p.variantLabel || "Option"',
    reason: "variant-label fallback in order display text",
  },
  // Review emoji rendered as Chip text, never a class.
  {
    file: "components/utility-components/checkout-card.tsx",
    snippet: 'value === "1" ? "👍" : "👎"',
    reason: "thumbs-up/down emoji in Chip label text",
  },
  // Display-text fallbacks in the seller orders dashboard.
  {
    file: "components/messages/orders-dashboard.tsx",
    snippet: 'returnRequestOrder.productTitle || "Unknown Product"',
    reason: "product-title fallback in return-request display text",
  },
  {
    file: "components/messages/orders-dashboard.tsx",
    snippet: 'order.variantLabel || "Option"',
    reason: "variant-label fallback in order display text",
  },
  {
    file: "components/messages/orders-dashboard.tsx",
    snippet: "order.donationPercentage !== undefined ? `",
    reason: "donation-percentage suffix in order display text",
  },
];

// Legitimate non-class '+' concatenations with a string-literal conditional
// branch the whole-file concat scan must not flag. Each entry matches when
// `snippet` (whitespace-normalized) is a substring of the offending
// concatenation chain's normalized text. Same contract as the template
// allowlist: class-feeding strings belong in joinClassNames, and unused
// entries fail the guard. No storefront file has a legitimate entry today —
// every conditional concat there composes classes through joinClassNames; the
// entries below are the buyer/seller message bodies and order-summary
// suffixes in the scoped non-storefront surfaces.
const NON_CLASS_CONCAT_ALLOWLIST: Array<{
  file: string;
  snippet: string;
  reason: string;
}> = [
  // Spec-variant suffix + buyer/seller message bodies in
  // components/product-invoice-card.tsx.
  {
    file: "components/product-invoice-card.tsx",
    snippet: '" (" + (variantLabel || "Option")',
    reason: "spec-variant suffix in order summary text",
  },
  {
    file: "components/product-invoice-card.tsx",
    snippet: '"You have received an order from " + (userNPub',
    reason: "seller order-notification message text",
  },
  {
    file: "components/product-invoice-card.tsx",
    snippet: '"You have received a payment from " + (userNPub',
    reason: "seller payment-notification message text",
  },
  {
    file: "components/product-invoice-card.tsx",
    snippet: '"Please ship the product" + productDetails',
    reason: "seller shipping-instructions message text",
  },
  {
    file: "components/product-invoice-card.tsx",
    snippet: '"This is a Cashu token payment from " + (userNPub',
    reason: "seller Cashu-payment message text",
  },
  {
    file: "components/product-invoice-card.tsx",
    snippet: '"This is an escrowed Cashu payment from " + (userNPub',
    reason: "seller escrowed-payment message text",
  },
  {
    file: "components/product-invoice-card.tsx",
    snippet: '"You have received a stripe payment from " + (userNPub',
    reason: "seller Stripe-payment message text",
  },
  // Same message bodies in components/cart-invoice-card.tsx.
  {
    file: "components/cart-invoice-card.tsx",
    snippet: '"You have received a " + (isStripe ? "Stripe" : "Square")',
    reason: "seller card-payment message text",
  },
  {
    file: "components/cart-invoice-card.tsx",
    snippet: '") was processed successfully via " +',
    reason: "buyer cart-confirmation message text",
  },
  {
    file: "components/cart-invoice-card.tsx",
    snippet: '"You have received an order from " + (userNPub',
    reason: "seller order-notification message text",
  },
  {
    file: "components/cart-invoice-card.tsx",
    snippet: '"Thank you for your purchase of " + (product.title',
    reason: "buyer thank-you message text",
  },
  {
    file: "components/cart-invoice-card.tsx",
    snippet: '" (" + (product.variantLabel || "Option")',
    reason: "spec-variant suffix in order summary text",
  },
  {
    file: "components/cart-invoice-card.tsx",
    snippet: '"You have received a payment from " + (userNPub',
    reason: "seller payment-notification message text",
  },
  {
    file: "components/cart-invoice-card.tsx",
    snippet: '"This is a Cashu token payment from " + (userNPub',
    reason: "seller Cashu-payment message text",
  },
  {
    file: "components/cart-invoice-card.tsx",
    snippet: '"This is an escrowed Cashu payment from " + (userNPub',
    reason: "seller escrowed-payment message text",
  },
  {
    file: "components/cart-invoice-card.tsx",
    snippet: '"Beef Initiative donation (" + beefDonationPercentage',
    reason: "donation-notification message text",
  },
  // Buyer-facing notification messages in the seller orders dashboard.
  {
    file: "components/messages/orders-dashboard.tsx",
    snippet: '"Your order has been shipped!" + (trackingNumber',
    reason: "buyer shipping-notification message text",
  },
  {
    file: "components/messages/orders-dashboard.tsx",
    snippet: "+ (addressChangeOrder.subscriptionId ?",
    reason: "address-change-request message text",
  },
];

// Legitimate non-class array-join/String.concat assemblies the join/concat
// scan must not flag. Each entry matches when `snippet`
// (whitespace-normalized) is a substring of the offending call's normalized
// text. Same contract as the other allowlists: class-feeding strings belong
// in joinClassNames, and unused entries fail the guard. No scanned file has
// a legitimate entry today — every existing `.join()` with a whitespace-free
// separator (font-query "&", CSV ",") branches nowhere near a string
// literal, and nothing uses String.concat.
const NON_CLASS_JOIN_CONCAT_ALLOWLIST: Array<{
  file: string;
  snippet: string;
  reason: string;
}> = [];

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
  const scannedScopedFiles = SCOPED_NON_STOREFRONT_FILES.map((p) =>
    join(process.cwd(), p)
  );
  // Files held to the three generic scans (className templates, whole-file
  // templates, '+' concatenation): sections, storefront chrome, and the
  // scoped non-storefront surfaces.
  const genericScanFiles = [
    ...scannedFiles,
    ...scannedChromeFiles,
    ...scannedScopedFiles,
  ];
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
  // storefront chrome components outside sections/ plus the scoped
  // non-storefront surfaces are held to the same bar.
  for (const file of genericScanFiles) {
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
  for (const file of genericScanFiles) {
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

  // Whole-file '+' concatenation check: the last hand-written shape — plain
  // string concatenation whose operands include a conditional
  // (`className={"font-bold" + (cond ? " md:text-5xl" : "")}` or `"flex " +
  // (cond ? rowClass : colClass)`). Every string-building '+' chain in these
  // files is walked; a flagged chain is an offender unless it is a named
  // non-class use in NON_CLASS_CONCAT_ALLOWLIST.
  const usedConcatAllowlistEntries = new Set<number>();
  for (const file of genericScanFiles) {
    const rel = relative(process.cwd(), file);
    const source = readFileSync(file, "utf8");

    for (const text of stringConcatConditionals(source, rel)) {
      const normalized = normalizeWhitespace(text);
      const allowIdx = NON_CLASS_CONCAT_ALLOWLIST.findIndex(
        (entry) =>
          entry.file === rel &&
          normalized.includes(normalizeWhitespace(entry.snippet))
      );
      if (allowIdx !== -1) {
        usedConcatAllowlistEntries.add(allowIdx);
        continue;
      }
      offenders.push({
        file: rel,
        label: `conditional operand in '+' string concatenation \`${normalized}\` (compose classNames with joinClassNames)`,
      });
    }
  }

  // Whole-file array-join/String.concat check: the two remaining
  // hand-written shapes — ["font-bold", cond ? "md:text-5xl" : ""].join("")
  // and "font-bold".concat(cond ? " md:text-5xl" : ""). Every `.join()` with
  // a whitespace-free (or missing) separator and every `.concat()` in these
  // files is walked; a flagged call is an offender unless it is a named
  // non-class use in NON_CLASS_JOIN_CONCAT_ALLOWLIST.
  const usedJoinConcatAllowlistEntries = new Set<number>();
  for (const file of genericScanFiles) {
    const rel = relative(process.cwd(), file);
    const source = readFileSync(file, "utf8");

    for (const text of joinConcatConditionals(source, rel)) {
      const normalized = normalizeWhitespace(text);
      const allowIdx = NON_CLASS_JOIN_CONCAT_ALLOWLIST.findIndex(
        (entry) =>
          entry.file === rel &&
          normalized.includes(normalizeWhitespace(entry.snippet))
      );
      if (allowIdx !== -1) {
        usedJoinConcatAllowlistEntries.add(allowIdx);
        continue;
      }
      offenders.push({
        file: rel,
        label: `conditional class assembly via array join/String.concat \`${normalized}\` (compose classNames with joinClassNames)`,
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

  it("finds no conditional class concatenation joined with '+' in any scanned file", () => {
    const concatOffenders = offenders.filter((o) =>
      o.label.includes("string concatenation")
    );
    expect(concatOffenders).toEqual([]);
  });

  it("finds no conditional class assembly via array .join() or String.concat in any scanned file", () => {
    const joinConcatOffenders = offenders.filter((o) =>
      o.label.includes("array join/String.concat")
    );
    expect(joinConcatOffenders).toEqual([]);
  });

  it("keeps the non-class allowlists tight (no unused entries)", () => {
    // An entry whose expression was edited or deleted would silently rot into
    // a loophole for anything matching its snippet — fail loudly instead.
    const unusedTemplates = NON_CLASS_TEMPLATE_ALLOWLIST.filter(
      (_, idx) => !usedAllowlistEntries.has(idx)
    );
    expect(unusedTemplates).toEqual([]);
    const unusedConcats = NON_CLASS_CONCAT_ALLOWLIST.filter(
      (_, idx) => !usedConcatAllowlistEntries.has(idx)
    );
    expect(unusedConcats).toEqual([]);
    const unusedJoinConcats = NON_CLASS_JOIN_CONCAT_ALLOWLIST.filter(
      (_, idx) => !usedJoinConcatAllowlistEntries.has(idx)
    );
    expect(unusedJoinConcats).toEqual([]);
  });

  it("scans every section file (guard against a silently broken walk)", () => {
    // If the directory or the filename convention changes, this guard must
    // fail loudly instead of silently scanning nothing.
    expect(scannedFiles.length).toBeGreaterThanOrEqual(20);
    expect(scannedFiles).toContain(join(SECTIONS_DIR, "section-elements.tsx"));
  });

  it("scans the scoped non-storefront surfaces (guard against a silently broken walk)", () => {
    // A renamed or deleted scoped file must fail loudly here instead of
    // silently dropping out of the three generic scans.
    for (const rel of SCOPED_NON_STOREFRONT_FILES) {
      const abs = join(process.cwd(), rel);
      expect(statSync(abs).isFile()).toBe(true);
      expect(genericScanFiles).toContain(abs);
    }
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

  it("detects conditional string concatenation joined with '+' (guard self-check)", () => {
    // The bug shape this layer exists to catch: both template scans are blind
    // to plain concatenation, the concat walk must not be — inline in
    // className or assigned to a variable first, with ternary, &&, or ||.
    const forbidden = [
      'const el = <div className={"font-bold" + (cond ? " md:text-5xl" : "")} />;',
      'const cls = "flex " + (cond ? "md:flex-row" : "flex-col");',
      'const cls = base + (enabled && "active");',
      'const cls = base + (override || "default-class");',
      // Variable branches are the same hand-rolled conditional class
      // composition — the branch shape must not matter.
      'const cls = "flex " + (cond ? rowClass : colClass);',
      'const cls = "base " + (enabled && activeClass);',
      'const cls = "base " + (override || defaultClass);',
      // Root-wrapping parens and longer chains must not smuggle it past.
      'const cls = "a" + ((cond ? "b" : "c")) + other;',
      'const cls = prefix + "mid " + (cond ? " x" : "y");',
    ];
    for (const sample of forbidden) {
      expect(stringConcatConditionals(sample, "sample.tsx")).not.toEqual([]);
    }
    // A multi-link chain is reported once, not per link.
    expect(
      stringConcatConditionals(
        'const cls = "a" + (cond ? "b" : "c") + other;',
        "sample.tsx"
      )
    ).toHaveLength(1);
    // Stays allowed: no conditional operand, no string literal anywhere in
    // the chain (numeric/unknown-typed conditionals), conditionals nested
    // inside call arguments, and plain color-suffix concats like
    // colors.secondary + "08".
    const allowed = [
      "const x = a + b;",
      'const bg = colors.secondary + "08";',
      "const label = prefix + format(cond ? 1 : 2);",
      "const n = count + (cond ? 1 : 2);",
      "const n = count + (cond ? surcharge : discount);",
      'const s = `flex ${cond ? "a" : "b"}`;', // template scan's territory
    ];
    for (const sample of allowed) {
      expect(stringConcatConditionals(sample, "sample.tsx")).toEqual([]);
    }
  });

  it("detects conditional class assembly via array .join() and String.concat (guard self-check)", () => {
    // The bug shapes this layer exists to catch: every prior scan is blind to
    // array-join and concat assembly — a whitespace-free separator or
    // separator-less concat glues the same dead token when a conditional
    // branch drops its leading space, inline in className or assigned to a
    // variable first, with ternary, &&, or ||.
    const forbidden = [
      'const el = <div className={["font-bold", cond ? "md:text-5xl" : ""].join("")} />;',
      'const cls = ["flex", cond ? "md:flex-row" : "flex-col"].join("");',
      // A missing separator joins on "," — no whitespace, same glued token.
      'const cls = ["font-bold", cond ? "md:text-5xl" : ""].join();',
      // The conditional can hide inside a map/filter callback.
      'const cls = items.map((i) => (i.on ? "active" : "")).join("");',
      'const cls = parts.filter((p) => (on ? p : "fallback")).join(",");',
      // Variable branches are the same hand-rolled composition.
      'const cls = ["flex", cond ? rowClass : colClass].join("");',
      // String.concat never supplies a separator.
      'const cls = "font-bold".concat(cond ? " md:text-5xl" : "");',
      'const cls = "flex ".concat(cond ? rowClass : colClass);',
      'const cls = base.concat(" ", enabled && "active");',
      'const cls = base.concat(override || "default-class");',
    ];
    for (const sample of forbidden) {
      expect(joinConcatConditionals(sample, "sample.tsx")).not.toEqual([]);
    }
    // Stays allowed: a whitespace separator composes tokens safely like
    // joinClassNames; no conditional or no string literal in the subtree
    // means numeric/business-logic assembly; a non-literal separator can't
    // be audited statically; concat on arrays isn't string assembly.
    const allowed = [
      'const cls = ["font-bold", cond ? "md:text-5xl" : ""].join(" ");',
      'const cls = joinClassNames("font-bold", cond ? "md:text-5xl" : "");',
      'const csv = rows.map(escape).join(",");',
      'const qs = families.map((f) => `family=${f}`).join("&");',
      'const n = [1, cond ? 2 : 3].join("");',
      'const cls = ["font-bold", cond ? "md:text-5xl" : ""].join(separator);',
      'const arr = base.concat(cond ? [1] : [2]);',
      'const label = "Total: ".concat(format(count));',
      // No conditional in the joined subtree — the ternary lives outside.
      'const label = parts.length > 0 ? parts.join(" + ") : "DISCOUNT";',
    ];
    for (const sample of allowed) {
      expect(joinConcatConditionals(sample, "sample.tsx")).toEqual([]);
    }
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
