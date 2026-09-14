// Joins whole class tokens with single spaces, dropping blanks.
// INVARIANT: every className that mixes static tokens with a conditional must
// be composed through this joiner — never a hand-written template literal like
// `flex ${cond ? "md:flex-row" : "flex-col"}` or a "flex " + (cond ? "a" :
// "b") concatenation. The `font-boldmd:text-5xl` regression came from exactly
// such a template (`font-bold${cond ? "" : "md:text-5xl"}`) missing its
// separating space; joining tokens on explicit whitespace here makes that
// merged-class bug impossible by construction instead of merely caught by
// tests. The static guards in
// __tests__/components/storefront/section-class-builder-guard.test.ts fail on
// any conditional string inside a scanned file's className template literal
// — and, via a TypeScript-AST walk of every template literal / '+' string
// concatenation in the file, on the same pattern one level removed
// (conditional class string assigned to a variable that then feeds
// className), with allowlists for the few legitimate non-class uses (display
// text, CSS blocks, font fallbacks). Storefront sections compose through the
// headingClassName/bodyClassName builders in
// components/storefront/sections/section-elements.tsx, which sit on top of
// this joiner; section-elements re-exports joinClassNames from here so
// storefront and non-storefront components share one implementation.
export function joinClassNames(
  ...tokens: Array<string | false | null | undefined>
): string {
  return tokens.filter(Boolean).join(" ");
}
