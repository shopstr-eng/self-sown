/** @jest-environment node */

// Web mirror of __tests__/mobile/apple-pay-marks.test.tsx. Apple's rule:
// wherever a page advertises Apple Pay acceptance, it must show Apple's OWN
// mark from the Tap to Pay on iPhone Marketing Toolkit — never recreated
// artwork, and never cropped/recolored/overlaid (rules + provenance:
// apps/mobile/lib/tap-to-pay-marketing-copy.ts). On web the toolkit SVGs are
// served unmodified from public/tap-to-pay/logo/ and rendered via <img>:
//
//   1. Fidelity: the public copies are byte-for-byte the committed toolkit
//      SVGs — a hand-tweaked "web-optimized" copy is a compliance violation.
//   2. Surface wiring: every page that names Apple Pay as an accepted payment
//      renders the toolkit mark, so a new acceptance surface can't quietly
//      ship text-only again.
//   3. Size-only rendering: the only transformation Apple's marketing rules
//      allow is uniform scaling — the <img> pins one dimension and lets the
//      other follow the toolkit aspect ratio.

import { readFileSync, readdirSync } from "fs";
import path from "path";

const WEB_ROOT = path.join(__dirname, "../..");
const TOOLKIT_LOGO_DIR = path.join(
  WEB_ROOT,
  "apps/mobile/assets/tap-to-pay/logo"
);
const PUBLIC_LOGO_DIR = path.join(WEB_ROOT, "public/tap-to-pay/logo");

const MARK_SRC = "/tap-to-pay/logo/Apple_Pay_Mark_RGB_041619.svg";

const sourceOf = (rel: string) =>
  readFileSync(path.join(WEB_ROOT, rel), "utf8");

describe("web Apple Pay mark fidelity", () => {
  it.each([
    "Apple_Pay_Mark_RGB_041619.svg",
    "Apple_Pay_logo_blk_052819.svg",
    "Apple_Pay_logo_wht_052819.svg",
  ])("serves public/tap-to-pay/logo/%s byte-for-byte unmodified", (name) => {
    const webCopy = readFileSync(path.join(PUBLIC_LOGO_DIR, name));
    const toolkitCopy = readFileSync(path.join(TOOLKIT_LOGO_DIR, name));
    expect(webCopy.equals(toolkitCopy)).toBe(true);
  });

  it("serves no extra artwork that isn't a verified toolkit file", () => {
    // A hand-made lookalike dropped into the served directory would be
    // indistinguishable from the real marks to a reader; the directory must
    // contain exactly the three verified toolkit SVGs.
    expect(readdirSync(PUBLIC_LOGO_DIR).sort()).toEqual(
      readdirSync(TOOLKIT_LOGO_DIR).sort()
    );
  });
});

describe("web Apple Pay mark surface wiring", () => {
  it.each([
    // FAQ "What payment methods are accepted?" answer names Apple Pay twice.
    "pages/faq/index.tsx",
    // Tap to Pay product page (marketing placement naming Apple Pay).
    "pages/tap-to-pay/index.tsx",
  ])("%s renders the toolkit acceptance mark", (rel) => {
    const source = sourceOf(rel);
    expect(source).toContain(MARK_SRC);
    expect(source).toMatch(/alt="Apple Pay"/);
  });

  it("binds the FAQ mark to the answer that advertises Apple Pay", () => {
    // The FAQ content is data-driven: the applePayMark flag on the
    // payment-methods answer is what renders the mark. Guard both halves so
    // an edit to the answer copy can't silently drop the artwork (or leave a
    // stranded flag on an answer that no longer names Apple Pay).
    const faq = sourceOf("pages/faq/index.tsx");
    expect(faq).toMatch(
      /content:\s*"[^"]*Apple Pay[^"]*",\s*\/\/[^/]*\n(\s*\/\/[^\n]*\n)*\s*applePayMark: true/
    );
    expect(faq).toMatch(/"applePayMark" in item && item\.applePayMark/);
  });

  it("scales the mark uniformly (size-only transformation)", () => {
    // Every <img> of the mark pins width and sets h-auto so height follows
    // the toolkit aspect ratio — no crop, no stretch, no recolor.
    for (const rel of ["pages/faq/index.tsx", "pages/tap-to-pay/index.tsx"]) {
      const source = sourceOf(rel);
      const imgTags = source.match(/<img[\s\S]*?\/>/g) ?? [];
      const markTags = imgTags.filter((tag) => tag.includes(MARK_SRC));
      expect(markTags.length).toBeGreaterThan(0);
      for (const tag of markTags) {
        expect(tag).toMatch(/width=\{\d+\}/);
        expect(tag).toContain("h-auto");
        expect(tag).not.toMatch(/height=\{/);
      }
    }
  });
});
