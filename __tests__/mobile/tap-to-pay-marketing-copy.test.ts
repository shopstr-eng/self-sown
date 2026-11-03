/** @jest-environment node */

// Guards Apple's disclaimer-pairing rules for the Tap to Pay marketing copy
// module. Apple's contract: the disclaimers accompany ALL advertising; the
// short form ("Terms apply.") is only legal because it clicks through to a
// product page showing the full disclaimer. These tests fail if a new
// push/SEO placement ships copy without the short disclaimer, if the
// click-through target is removed, or if the asterisked card-storage copy
// loses its bound disclaimer.

import {
  APPLE_PAY_SERVICE_DISCLAIMER,
  TAP_TO_PAY_CARD_STORAGE_DISCLAIMER,
  TAP_TO_PAY_CONTACTLESS_INDICATOR_DISCLAIMER,
  TAP_TO_PAY_CONTACTLESS_SYMBOL_DISCLAIMER,
  TAP_TO_PAY_COPY_BLOCKS,
  TAP_TO_PAY_FULL_DISCLAIMER,
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
