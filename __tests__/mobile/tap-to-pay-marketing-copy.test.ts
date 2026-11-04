/** @jest-environment node */

// Guards Apple's disclaimer-pairing rules for the Tap to Pay marketing copy
// module. Apple's contract: the disclaimers accompany ALL advertising; the
// short form ("Terms apply.") is only legal because it clicks through to a
// product page showing the full disclaimer. These tests fail if a new
// push/SEO placement ships copy without the short disclaimer, if the
// click-through target is removed, or if the asterisked card-storage copy
// loses its bound disclaimer.

import * as fs from "fs";
import * as path from "path";

import {
  APPLE_PAY_SERVICE_DISCLAIMER,
  isTapToPayNowPhrasingPermitted,
  TAP_TO_PAY_CARD_STORAGE_DISCLAIMER,
  TAP_TO_PAY_CONTACTLESS_INDICATOR_DISCLAIMER,
  TAP_TO_PAY_CONTACTLESS_SYMBOL_DISCLAIMER,
  TAP_TO_PAY_COPY_BLOCKS,
  TAP_TO_PAY_FULL_DISCLAIMER,
  TAP_TO_PAY_LAUNCH_DATE,
  TAP_TO_PAY_NOW_PHRASING_ENDS,
  TAP_TO_PAY_PRODUCT_PAGE_PATH,
  TAP_TO_PAY_PUSH_COPY,
  TAP_TO_PAY_SEO_COPY,
  TAP_TO_PAY_SHORT_DISCLAIMER,
} from "../../packages/domain/src/tap-to-pay-marketing-copy";

describe("Tap to Pay disclaimer pairing", () => {
  it("every SEO copy placement ends with the short disclaimer", () => {
    expect(TAP_TO_PAY_SEO_COPY.length).toBeGreaterThan(0);
    for (const placement of TAP_TO_PAY_SEO_COPY) {
      expect(placement.body.endsWith(TAP_TO_PAY_SHORT_DISCLAIMER)).toBe(true);
    }
  });

  it("every push copy placement ends with the short disclaimer", () => {
    expect(TAP_TO_PAY_PUSH_COPY.length).toBeGreaterThan(0);
    for (const placement of TAP_TO_PAY_PUSH_COPY) {
      expect(placement.body.endsWith(TAP_TO_PAY_SHORT_DISCLAIMER)).toBe(true);
    }
  });

  it("exposes a product page path for the short disclaimer to click through to", () => {
    // Registered as a real page (pages/tap-to-pay) and in the marketing-page
    // surfaces; the shape guard here catches an accidental removal/rename at
    // the module level.
    expect(TAP_TO_PAY_PRODUCT_PAGE_PATH).toMatch(/^\/[a-z-]+$/);
  });

  it("keeps the full disclaimer available for that product page", () => {
    expect(TAP_TO_PAY_FULL_DISCLAIMER).toContain(
      "Tap to Pay on iPhone requires a supported payment app"
    );
    expect(TAP_TO_PAY_FULL_DISCLAIMER).toContain(
      "https://developer.apple.com/tap-to-pay/regions/"
    );
  });

  it("binds every asterisked card-storage copy block to its disclaimer", () => {
    const asterisked = TAP_TO_PAY_COPY_BLOCKS.flatMap((block) => [
      ...block.advertisingCopy,
      ...(block.longCopy ? [block.longCopy] : []),
    ]).filter((copy) => copy.includes("*"));
    // Apple attaches the asterisk to the "Apple doesn't store card numbers"
    // claim; each asterisked block needs TAP_TO_PAY_CARD_STORAGE_DISCLAIMER
    // rendered beside it, so the disclaimer must exist and stay asterisked.
    expect(asterisked.length).toBeGreaterThan(0);
    for (const copy of asterisked) {
      expect(copy).toContain("Apple doesn’t store card numbers");
    }
    expect(TAP_TO_PAY_CARD_STORAGE_DISCLAIMER.startsWith("*")).toBe(true);
    expect(TAP_TO_PAY_CARD_STORAGE_DISCLAIMER).toContain(
      "Store and Forward mode"
    );
  });

  it("keeps the mark/service notices the renderers rely on", () => {
    expect(TAP_TO_PAY_CONTACTLESS_INDICATOR_DISCLAIMER).toContain("EMVCo");
    expect(TAP_TO_PAY_CONTACTLESS_SYMBOL_DISCLAIMER).toContain("EMVCo");
    expect(APPLE_PAY_SERVICE_DISCLAIMER).toContain(
      "Apple Payments Services LLC"
    );
  });
});

describe("[now] phrasing launch window", () => {
  // Apple's rule: the bracketed [now] phrasing is permitted from launch
  // through the first six months, then must be removed everywhere it shipped.
  it("records a launch date and a window end exactly six months later", () => {
    const launch = new Date(`${TAP_TO_PAY_LAUNCH_DATE}T00:00:00Z`);
    expect(launch.getTime()).not.toBeNaN();
    const expectedEnd = new Date(
      Date.UTC(
        launch.getUTCFullYear(),
        launch.getUTCMonth() + 6,
        launch.getUTCDate()
      )
    );
    expect(TAP_TO_PAY_NOW_PHRASING_ENDS).toBe(
      expectedEnd.toISOString().slice(0, 10)
    );
  });

  it("permits [now] phrasing only inside the six-month window", () => {
    expect(
      isTapToPayNowPhrasingPermitted(
        new Date(`${TAP_TO_PAY_LAUNCH_DATE}T00:00:00Z`)
      )
    ).toBe(true);
    expect(
      isTapToPayNowPhrasingPermitted(
        new Date(Date.parse(`${TAP_TO_PAY_NOW_PHRASING_ENDS}T00:00:00Z`) - 1)
      )
    ).toBe(true);
    expect(
      isTapToPayNowPhrasingPermitted(
        new Date(`${TAP_TO_PAY_NOW_PHRASING_ENDS}T00:00:00Z`)
      )
    ).toBe(false);
  });

  it("has no leftover [now] phrasing once the window closes", () => {
    if (isTapToPayNowPhrasingPermitted()) {
      // Still inside the launch window — [now] is permitted. Nothing to strip
      // yet; this test starts failing the day the window closes.
      return;
    }
    for (const block of TAP_TO_PAY_COPY_BLOCKS) {
      const allCopy = [
        ...block.subheadlines,
        ...block.advertisingCopy,
        ...(block.longCopy ? [block.longCopy] : []),
      ];
      for (const copy of allCopy) {
        expect(copy).not.toContain("[now]");
      }
    }
    const launchEmail = path.join(
      __dirname,
      "../../generated-artifacts/TapToPay_Launch_Email.html"
    );
    if (fs.existsSync(launchEmail)) {
      expect(fs.readFileSync(launchEmail, "utf8")).not.toContain(
        "now available"
      );
    }
  });
});
