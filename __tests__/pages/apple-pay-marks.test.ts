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
//   4. Discovery: a repo-wide scan of pages/ and components/ fails when
//      comment-stripped source names Apple Pay in visible copy without
//      rendering a toolkit mark or holding a reviewed exception — so a NEW
//      acceptance page can't ship text-only by forgetting to update the
//      hand-maintained wiring lists above.

import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import * as ts from "typescript";
import { PAGE_CONTENT } from "@/utils/geo/page-content";
import {
  APPLE_PAY_SERVICE_DISCLAIMER,
  TAP_TO_PAY_PRODUCT_PAGE_PATH,
} from "@/apps/mobile/lib/tap-to-pay-marketing-copy";

const WEB_ROOT = path.join(__dirname, "../..");
const TOOLKIT_LOGO_DIR = path.join(
  WEB_ROOT,
  "apps/mobile/assets/tap-to-pay/logo"
);
const PUBLIC_LOGO_DIR = path.join(WEB_ROOT, "public/tap-to-pay/logo");

const MARK_SRC = "/tap-to-pay/logo/Apple_Pay_Mark_RGB_041619.svg";

const sourceOf = (rel: string) =>
  readFileSync(path.join(WEB_ROOT, rel), "utf8");

// Recursively lists shipped UI source files under a directory. pages/api
// names Apple Pay only in server-side comments and logs (domain
// registration, wallet setup) — never customer-facing copy. __tests__
// directories hold test doubles, not shipped UI.
const listPageFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      return entry === "api" || entry === "__tests__" ? [] : listPageFiles(abs);
    }
    if (/\.test\.tsx?$/.test(entry)) return [];
    return /\.tsx?$/.test(entry) ? [abs] : [];
  });

// Returns the source with every comment removed (line, trailing, block, and
// JSX {/* *\/}) while string literals and JSX text survive untouched, so the
// discovery scan judges only copy a buyer can actually see — a code comment
// explaining Apple's rules never trips it. Going through the TypeScript
// transformer (instead of regex) keeps URLs like "https://..." intact.
const stripComments = (source: string): string =>
  ts.transpileModule(source, {
    compilerOptions: {
      removeComments: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ESNext,
    },
    fileName: "surface.tsx",
  }).outputText;

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
    // Shared renderer every other mark surface goes through (see below).
    "components/utility-components/apple-pay-mark.tsx",
  ])("%s renders the toolkit acceptance mark", (rel) => {
    const source = sourceOf(rel);
    expect(source).toContain(MARK_SRC);
    expect(source).toMatch(/alt="Apple Pay"/);
  });

  // Buyer-facing surfaces where a seller's manual "Apple Pay" payment handle
  // is listed as a way to get paid. None of them may hand-roll the artwork:
  // each must render the shared PaymentOptionLabel/ApplePayMark so the mark,
  // alt text, and size-only scaling stay in one audited place. The seller
  // settings forms that CONFIGURE the handle stay nominative (registry
  // below); these are the surfaces that SHOW it to buyers.
  const MARK_COMPONENT_SURFACES = [
    // Single-product checkout: fiat option picker + payment instructions.
    "components/product-invoice-card.tsx",
    // Cart checkout: fiat option pickers + payment instructions (single- and
    // multi-seller).
    "components/cart-invoice-card.tsx",
    // Storefront order confirmation receipt ("Payment method: Apple Pay").
    "components/storefront/storefront-order-confirmation.tsx",
    // Buyer order-summary receipt.
    "pages/order-summary/index.tsx",
    // Orders dashboard payment-method column (also buyer-facing via the
    // storefront "Your Orders" view).
    "components/messages/orders-dashboard.tsx",
  ];

  it.each(MARK_COMPONENT_SURFACES)(
    "%s renders the mark via the shared component",
    (rel) => {
      const source = sourceOf(rel);
      expect(source).toMatch(
        /import\s*\{[^}]*PaymentOptionLabel[^}]*\}\s*from\s*"@\/components\/utility-components\/apple-pay-mark"/
      );
      expect(source).toMatch(/<PaymentOptionLabel/);
    }
  );

  it("only shows the mark for labels that actually name Apple Pay", () => {
    // Sellers type the handle freehand ("applepay", "Apple Pay", ...); the
    // detector must be case- and separator-insensitive so every variant gets
    // the mark, and must not fire on other wallets.
    const source = sourceOf("components/utility-components/apple-pay-mark.tsx");
    expect(source).toMatch(/isApplePayLabel/);
    expect(source).toContain("applepay");
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

  it("binds the FAQ mark AND service notice to the answer that advertises Apple Pay", () => {
    // The mark and APPLE_PAY_SERVICE_DISCLAIMER render inside the same
    // applePayMark-gated block, so the notice can't be dropped while the
    // mark (or the Apple Pay copy) stays.
    const faq = sourceOf("pages/faq/index.tsx");
    expect(faq).toMatch(
      /"applePayMark" in item && item\.applePayMark[\s\S]*Apple_Pay_Mark_RGB_041619\.svg[\s\S]*\{APPLE_PAY_SERVICE_DISCLAIMER\}/
    );
  });

  it("scales the mark uniformly (size-only transformation)", () => {
    // Every <img> of the mark pins width and sets h-auto so height follows
    // the toolkit aspect ratio — no crop, no stretch, no recolor. Pages pin a
    // numeric literal; the shared component takes the width as a prop, so its
    // check is pass-through width + never a height pin.
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
    const component = sourceOf(
      "components/utility-components/apple-pay-mark.tsx"
    );
    // `<img\s` (not `<img[\s\S]`) so prose mentions like "the <img> pins
    // width..." in comments don't get swallowed into the tag match.
    const componentImg = (component.match(/<img\s[\s\S]*?\/>/g) ?? []).filter(
      (tag) => tag.includes("APPLE_PAY_MARK_SRC")
    );
    expect(componentImg.length).toBeGreaterThan(0);
    for (const tag of componentImg) {
      expect(tag).toContain("width={width}");
      expect(tag).toContain("h-auto");
      expect(tag).not.toMatch(/height[=\s:]/);
    }
  });
});

describe("Apple Pay acceptance-copy discovery", () => {
  // The wiring lists above guard the pages we know about today, but they only
  // pass when someone remembers to add a new page by hand. This scan inverts
  // the responsibility: it walks every shipped page and component, strips
  // comments, and fails when surviving copy names Apple Pay without the file
  // rendering a toolkit mark or holding a reviewed exception below — a future
  // acceptance surface can't ship text-only by omission.
  //
  // Reviewed exceptions: files whose visible "Apple Pay" copy is NOT an
  // acceptance-advertising placement, so the mark rule does not apply. Each
  // entry names its justification, and the registry-honesty test below fails
  // if an entry stops naming Apple Pay, so the list is re-audited when copy
  // changes instead of rotting silently. Receipt-style echoes (order
  // confirmation, order summary, orders dashboard) never appear here: they
  // render the shared PaymentOptionLabel, which already appends the mark, so
  // they pass the scan on their own.
  const REVIEWED_MARK_EXCEPTIONS: Record<string, string> = {
    "components/dynamic-meta-head.tsx":
      "/tap-to-pay meta description is invisible head metadata, not on-page " +
      "copy, and uses Apple's sanctioned short form 'Terms apply.'",
    "components/settings/market-profile-form.tsx":
      "payment-method checkbox label in the seller's own settings form — " +
      "nominative configuration UI, never shown to buyers",
    "components/settings/shop-profile-form.tsx":
      "payment-method label map in the seller's discount settings — " +
      "nominative configuration UI, never shown to buyers",
  };

  // A file counts as rendering the toolkit mark when its comment-stripped
  // source serves one of the verified toolkit SVGs directly or goes through
  // the shared component (ApplePayMark / PaymentOptionLabel / the
  // APPLE_PAY_MARK_SRC constant). Checking the stripped source keeps a mere
  // comment mention of the logo path from counting as rendering.
  const rendersToolkitMark = (stripped: string): boolean =>
    stripped.includes("/tap-to-pay/logo/") ||
    stripped.includes("APPLE_PAY_MARK_SRC") ||
    /@\/components\/utility-components\/apple-pay-mark/.test(stripped);

  it("fails when visible copy names Apple Pay without a toolkit mark or a reviewed exception", () => {
    const offenders = ["pages", "components"]
      .flatMap((dir) => listPageFiles(path.join(WEB_ROOT, dir)))
      .map((abs) => path.relative(WEB_ROOT, abs))
      .filter((rel) => {
        const stripped = stripComments(sourceOf(rel));
        if (!stripped.includes("Apple Pay")) return false;
        return (
          !rendersToolkitMark(stripped) &&
          !(rel in REVIEWED_MARK_EXCEPTIONS)
        );
      });
    expect(offenders).toEqual([]);
  });

  it("ignores code comments, so comment-only mentions don't cry wolf", () => {
    // stripe-card-form names Apple Pay only in comments (Stripe renders the
    // wallet button itself); after stripping it must not be flagged.
    const stripped = stripComments(
      sourceOf("components/utility-components/stripe-card-form.tsx")
    );
    expect(stripped).not.toContain("Apple Pay");
  });

  it("keeps the reviewed-exception registry honest", () => {
    for (const [rel, justification] of Object.entries(
      REVIEWED_MARK_EXCEPTIONS
    )) {
      expect(justification.length).toBeGreaterThan(0);
      // A stale entry (file no longer names Apple Pay in visible copy) fails
      // here so the registry gets re-audited instead of silently rotting.
      expect(stripComments(sourceOf(rel))).toContain("Apple Pay");
      // An exception that starts rendering the mark is no longer an
      // exception — drop it from the registry and let the scan pass it.
      expect(rendersToolkitMark(stripComments(sourceOf(rel)))).toBe(false);
    }
  });
});

describe("Square checkout Apple Pay button fallback mark", () => {
  // The Square checkout renders its own Apple Pay button (the SDK has no
  // Apple Pay attach()). WebKit paints Apple's native mark via the
  // -apple-pay-button appearance; every other engine ignores it, so the
  // button must carry Apple's toolkit lockup itself or buyers there see an
  // unlabeled black rectangle.
  const BUTTON_SRC = "/tap-to-pay/logo/Apple_Pay_logo_wht_052819.svg";

  it("renders the unmodified toolkit lockup inside the button", () => {
    const source = sourceOf(
      "components/utility-components/square-card-form.tsx"
    );
    const button = source.match(
      /<button[\s\S]*?square-apple-pay-button[\s\S]*?<\/button>/
    );
    expect(button).not.toBeNull();
    expect(button![0]).toContain(BUTTON_SRC);
    expect(button![0]).toContain("square-apple-pay-button-mark");
    // Decorative inside an aria-labeled button — no double announcement.
    expect(button![0]).toMatch(/aria-label="Pay with Apple Pay"/);
    expect(button![0]).toMatch(/<img[^>]*alt=""/);
    // The white lockup is the served, byte-verified toolkit file.
    const webCopy = readFileSync(
      path.join(PUBLIC_LOGO_DIR, "Apple_Pay_logo_wht_052819.svg")
    );
    const toolkitCopy = readFileSync(
      path.join(TOOLKIT_LOGO_DIR, "Apple_Pay_logo_wht_052819.svg")
    );
    expect(webCopy.equals(toolkitCopy)).toBe(true);
  });

  it("scopes the native -apple-pay-button paint to WebKit and hides the fallback there", () => {
    const css = sourceOf("styles/globals.css");
    const supportsBlock = css.match(
      /@supports \(-webkit-appearance: -apple-pay-button\) \{([\s\S]*?)\n\}/
    );
    expect(supportsBlock).not.toBeNull();
    // Native paint must live inside the guard: outside it, non-WebKit
    // engines would get appearance rules they ignore anyway, but the guard
    // is also what hides the fallback mark.
    expect(supportsBlock![1]).toContain("-webkit-appearance: -apple-pay-button");
    expect(supportsBlock![1]).toMatch(
      /\.square-apple-pay-button-mark \{[\s\S]*?display: none;/
    );
    // Outside the guard the native paint must not leak: the base rule is
    // engine-neutral so non-WebKit keeps the fallback visible.
    const baseRule = css.match(/\.square-apple-pay-button \{([\s\S]*?)\n\}/);
    expect(baseRule).not.toBeNull();
    expect(baseRule![1]).not.toContain("-apple-pay-button");
  });

  it("scales the fallback mark uniformly (size-only transformation)", () => {
    const css = sourceOf("styles/globals.css");
    // One dimension pinned, the other follows the toolkit aspect ratio —
    // no crop, no stretch, no recolor.
    const markRule = css.match(/\.square-apple-pay-button-mark \{([\s\S]*?)\}/);
    expect(markRule).not.toBeNull();
    expect(markRule![1]).toMatch(/height: \d+px;/);
    expect(markRule![1]).toContain("width: auto;");
  });
});

describe("Apple Pay service notice", () => {
  // Apple's rule (apps/mobile/lib/tap-to-pay-marketing-copy.ts): the
  // APPLE_PAY_SERVICE_DISCLAIMER must accompany every customer-facing
  // advertising mention of Apple Pay. These are the web pages that name
  // Apple Pay in body copy and/or render the mark — each renders the shared
  // notice.
  const APPLE_PAY_PAGES = ["pages/faq/index.tsx", "pages/tap-to-pay/index.tsx"];

  // Nominative/transactional mentions that are NOT advertising placements:
  // they identify the payment method in functional UI (a settings label, a
  // wallet button, a receipt), which Apple's service-notice rule does not
  // cover, or they use Apple's sanctioned short form. Each entry names its
  // justification, and the registry-honesty test below fails if an entry
  // stops naming Apple Pay, so the list is re-audited when copy changes.
  const EXEMPT_NON_MARKETING: Record<string, string> = {
    "components/settings/market-profile-form.tsx":
      "payment-method checkbox label in the seller's settings form",
    "components/settings/shop-profile-form.tsx":
      "payment-method label map in the seller's discount settings",
    "components/utility-components/square-card-form.tsx":
      "Apple's own transactional wallet button at checkout (plus code comments)",
    "components/utility-components/stripe-card-form.tsx":
      "code comments only — Stripe renders the wallet button itself",
    "components/dynamic-meta-head.tsx":
      "/tap-to-pay meta description uses Apple's sanctioned short form " +
      "'Terms apply.', which clicks through to the /tap-to-pay page showing " +
      "the full notices",
    "utils/messages/order-message-utils.ts":
      "payment-method display name in order receipts",
    "components/utility-components/apple-pay-mark.tsx":
      "the shared component that renders the toolkit mark itself; the only " +
      "'Apple Pay' strings are the img alt text and the handle detector, " +
      "not marketing copy",
  };

  const NOTICED_OR_EXEMPT = [...APPLE_PAY_PAGES, ...Object.keys(EXEMPT_NON_MARKETING)];

  it.each(APPLE_PAY_PAGES)(
    "%s imports and renders the shared APPLE_PAY_SERVICE_DISCLAIMER",
    (rel) => {
      const source = sourceOf(rel);
      // Imported, never retyped, so the notice can't drift from Apple's
      // approved wording.
      expect(source).toMatch(
        /import\s*\{[^}]*APPLE_PAY_SERVICE_DISCLAIMER[^}]*\}\s*from\s*"@\/apps\/mobile\/lib\/tap-to-pay-marketing-copy"/
      );
      // Referenced beyond the import statement itself (rendered directly or
      // via a notices array).
      const withoutImports = source.replace(/^import[\s\S]*?from\s*"[^"]*";/gm, "");
      expect(withoutImports).toMatch(/APPLE_PAY_SERVICE_DISCLAIMER/);
    }
  );

  it("fails if a page or component names Apple Pay or renders the mark without the notice", () => {
    // Every UI source file (pages and the components they render) that
    // mentions Apple Pay at all must be a noticed surface or a documented
    // non-marketing exemption — a new acceptance surface can't quietly ship
    // the words or the mark without APPLE_PAY_SERVICE_DISCLAIMER.
    const offenders = ["pages", "components", "utils/messages"]
      .flatMap((dir) => listPageFiles(path.join(WEB_ROOT, dir)))
      .map((abs) => path.relative(WEB_ROOT, abs))
      .filter((rel) => {
        const source = sourceOf(rel);
        return source.includes("Apple Pay") || source.includes(MARK_SRC);
      })
      .filter((rel) => !NOTICED_OR_EXEMPT.includes(rel));
    expect(offenders).toEqual([]);
  });

  it("keeps the non-marketing exemption registry honest", () => {
    for (const [rel, justification] of Object.entries(EXEMPT_NON_MARKETING)) {
      expect(justification.length).toBeGreaterThan(0);
      // A stale entry (file no longer names Apple Pay) fails here so the
      // registry gets re-audited instead of silently rotting.
      expect(sourceOf(rel)).toContain("Apple Pay");
    }
  });

  it("never retypes the disclaimer text outside the marketing-copy module", () => {
    const literal =
      "Apple Pay is a service provided by Apple Payments Services LLC";
    const offenders = ["pages", "components"]
      .flatMap((dir) => listPageFiles(path.join(WEB_ROOT, dir)))
      .map((abs) => path.relative(WEB_ROOT, abs))
      .filter((rel) => sourceOf(rel).includes(literal));
    expect(offenders).toEqual([]);
  });
});

describe("Apple Pay service notice on agent-readable surfaces", () => {
  // Agent-readable surfaces are advertising placements too: Apple's rule
  // binds wherever Apple Pay is mentioned, including the content-negotiation
  // copy agents receive from /api/agent-view (utils/geo/page-content.ts) and
  // the llms.txt files they crawl. The page-content entries interpolate the
  // imported constant, so they can never retype it; the static .txt files
  // must carry it verbatim — every assertion below compares against the
  // module constant, so a hand-retyped or drifted notice fails.

  const entryText = (entry: { title: string; description: string; markdown: string }) =>
    `${entry.title}\n${entry.description}\n${entry.markdown}`;

  it("every agent-view page entry that names Apple Pay carries the service notice", () => {
    const offenders = Object.entries(PAGE_CONTENT)
      .filter(([, entry]) => entryText(entry).includes("Apple Pay"))
      .filter(
        ([, entry]) => !entryText(entry).includes(APPLE_PAY_SERVICE_DISCLAIMER)
      )
      .map(([pagePath]) => pagePath);
    expect(offenders).toEqual([]);
  });

  it("keeps the agent-view guard non-vacuous", () => {
    // If the /tap-to-pay entry stops naming Apple Pay, the scan above passes
    // vacuously and a future acceptance entry could ship without the notice
    // unnoticed. Pin one known naming entry so the guard is re-audited.
    const entry = PAGE_CONTENT[TAP_TO_PAY_PRODUCT_PAGE_PATH];
    expect(entry).toBeDefined();
    expect(entryText(entry!)).toContain("Apple Pay");
  });

  it.each(["public/llms.txt", "public/llms-full.txt"])(
    "%s carries the verbatim service notice where it names Apple Pay",
    (rel) => {
      const source = sourceOf(rel);
      // No Apple Pay mention, no notice required — but llms-full.txt names
      // Apple Pay today and the non-vacuous test below pins that.
      if (!source.includes("Apple Pay")) return;
      expect(source).toContain(APPLE_PAY_SERVICE_DISCLAIMER);
    }
  );

  it("keeps the llms-full.txt guard non-vacuous", () => {
    expect(sourceOf("public/llms-full.txt")).toContain("Apple Pay");
  });
});
