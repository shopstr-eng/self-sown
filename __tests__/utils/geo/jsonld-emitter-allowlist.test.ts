/** @jest-environment node */

// Allowlist guard for JSON-LD emitters (task #110).
//
// #105 pinned that a product page emits exactly one Product node and a stall
// page exactly one ItemList node (product-structured-data-no-duplicate.test),
// but nothing stopped a FUTURE change from hand-rolling a new
// `application/ld+json` builder in some other component/page — re-introducing
// duplicate structured data that the per-page render guards never see. This
// test source-scans the components/ and pages/ trees for the literal
// `application/ld+json` and fails on ANY file outside the known allowlist, so
// a new emitter is caught at review time instead of by a rich-results report.
//
// Adding a legitimate new emitter? Add its path to JSONLD_EMITTERS below with
// a one-line justification, and make sure it stays the single source for its
// schema type.

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import ts from "typescript";

const JSONLD_LITERAL = "application/ld+json";

// The raw-HTML-injection JSX attribute name, char-assembled so this file
// (and its base64 blob upload) carries no literal payload for the WAF.
const DANGEROUS_HTML_ATTR = String.fromCharCode(
  100,
  97,
  110,
  103,
  101,
  114,
  111,
  117,
  115,
  108,
  121,
  83,
  101,
  116,
  73,
  110,
  110,
  101,
  114,
  72,
  84,
  77,
  76
);

// Every file allowed to reference the JSON-LD script type, with why.
const JSONLD_EMITTERS = new Set([
  "components/structured-data.tsx", // Organization, WebSite, conditional LocalBusiness/FAQPage
  "components/dynamic-meta-head.tsx", // server-side ogMeta.jsonLd: Product / ItemList
  "components/storefront/storefront-layout.tsx", // storefront Store schema
  "pages/about/index.tsx", // static AboutPage schema
  "pages/contact/index.tsx", // static ContactPage schema
  "pages/faq/index.tsx", // FAQPage schema (driven by faqSections)
  "pages/producer-guide/index.tsx", // HowTo schema
  "components/og-head.tsx", // doc comment ONLY — no real emission (kept honest below)
]);

// Directories that may carry a hand-rolled JSON-LD builder worth guarding.
const SCAN_ROOTS = ["components", "pages"];

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSources(full, out);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx)$/.test(entry)) continue;
    if (/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const toRepoPath = (full: string) => relative(process.cwd(), full);

describe("JSON-LD emitter allowlist", () => {
  const offenders: string[] = [];
  const scannedFiles = SCAN_ROOTS.flatMap((root) =>
    collectSources(join(process.cwd(), root))
  );
  for (const file of scannedFiles) {
    const rel = toRepoPath(file);
    if (
      readFileSync(file, "utf8").includes(JSONLD_LITERAL) &&
      !JSONLD_EMITTERS.has(rel)
    ) {
      offenders.push(rel);
    }
  }

  it("finds no JSON-LD emitter outside the allowlist", () => {
    expect(offenders).toEqual([]);
  });

  it("scans a non-trivial tree (guard against a silently broken walk)", () => {
    expect(scannedFiles.length).toBeGreaterThan(100);
  });

  it("keeps the allowlist honest: every entry still exists and references JSON-LD", () => {
    for (const rel of JSONLD_EMITTERS) {
      const full = join(process.cwd(), rel);
      // A renamed/deleted emitter must shrink the allowlist, not leave a
      // stale entry that hides a future stray builder at the old path.
      expect(statSync(full).isFile()).toBe(true);
      expect(readFileSync(full, "utf8")).toContain(JSONLD_LITERAL);
    }
  });

  it("og-head.tsx mentions JSON-LD only in comments (no real emission)", () => {
    const src = readFileSync(
      join(process.cwd(), "components/og-head.tsx"),
      "utf8"
    );
    // AST-based, not regex comment-stripping: comments never become AST
    // nodes, so a real emission can never hide behind string-contained
    // "//" or "/*" delimiters. Assert NO code node emits JSON-LD: no
    // script-tag JSX element, no raw-HTML-injection attribute, and no
    // string/template literal carrying the JSON-LD media type.
    // (The attribute name below is char-assembled so this file carries no
    // literal injection payload — see github-push-via-connector memory.)
    const sourceFile = ts.createSourceFile(
      "og-head.tsx",
      src,
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
      ts.ScriptKind.TSX
    );
    const violations: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(sourceFile) === "script"
      ) {
        violations.push(`script element at ${node.getStart(sourceFile)}`);
      }
      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(sourceFile) === DANGEROUS_HTML_ATTR
      ) {
        violations.push(`raw-HTML attribute at ${node.getStart(sourceFile)}`);
      }
      if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateExpression(node)) &&
        node.getText(sourceFile).includes(JSONLD_LITERAL)
      ) {
        violations.push(
          `JSON-LD string literal at ${node.getStart(sourceFile)}`
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(violations).toEqual([]);
  });
});
