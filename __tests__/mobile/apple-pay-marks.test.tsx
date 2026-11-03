/** @jest-environment node */

// Guards the Apple Pay mark wiring (Apple's rule: wherever the app advertises
// Apple Pay / Tap to Pay acceptance, it must show Apple's OWN mark from the
// Tap to Pay on iPhone Marketing Toolkit — never a recreated badge, and never
// cropped/recolored/overlaid):
//
//   1. Fidelity: the XML embedded in components/apple-pay-mark.tsx is
//      byte-for-byte the committed toolkit SVGs (assets/tap-to-pay/logo/) —
//      a hand-tweaked copy would be a compliance violation.
//   2. Surface wiring: every screen that advertises Apple Pay / Tap to Pay
//      acceptance renders the shared mark component, so a new screen can't
//      quietly ship text-only acceptance again.
//   3. Rendering: the components pass the untouched XML to SvgXml with an
//      accessible label.

import { readFileSync } from "fs";
import path from "path";

const MOBILE_ROOT = path.join(__dirname, "../../apps/mobile");

// Host-component stand-ins (same pattern as the sibling mobile suites):
// @testing-library/react-native requires "react-native" internally, and
// under pnpm that never matches a non-virtual mock registered from here.
jest.mock(
  "react-native",
  () => ({
    View: "View",
    Text: "Text",
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten: (style: unknown) => style,
    },
  }),
  { virtual: true }
);

// react-native-svg has no JS runtime here; capture the SvgXml props instead.
const svgXmlCalls: Array<Record<string, unknown>> = [];
jest.mock(
  "react-native-svg",
  () => ({
    SvgXml: (props: Record<string, unknown>) => {
      svgXmlCalls.push(props);
      return null;
    },
  }),
  { virtual: true }
);

import {
  ApplePayMark,
  ApplePayLogo,
  APPLE_PAY_MARK_XML_SOURCE,
  APPLE_PAY_LOGO_BLACK_XML_SOURCE,
  APPLE_PAY_LOGO_WHITE_XML_SOURCE,
} from "../../apps/mobile/components/apple-pay-mark";

// Requiring (not importing) @testing-library/react-native keeps the
// jest.mock("react-native", ...) registration above in effect when RNTL
// loads: the next/jest SWC transform does NOT hoist jest.mock calls above
// static ESM imports, and RNTL requires the real (ESM, untransformed)
// react-native at module load, which would crash before the mock registers.
// RNTL v14's render is async.
import type { ReactElement } from "react";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { render } = require("@testing-library/react-native") as {
  render: (ui: ReactElement) => Promise<unknown>;
};

const toolkitFile = (name: string) =>
  readFileSync(
    path.join(MOBILE_ROOT, "assets/tap-to-pay/logo", name),
    "utf8"
  ).trim();

describe("Apple Pay mark fidelity", () => {
  it("embeds the toolkit SVGs byte-for-byte", () => {
    expect(APPLE_PAY_MARK_XML_SOURCE).toBe(
      toolkitFile("Apple_Pay_Mark_RGB_041619.svg")
    );
    expect(APPLE_PAY_LOGO_BLACK_XML_SOURCE).toBe(
      toolkitFile("Apple_Pay_logo_blk_052819.svg")
    );
    expect(APPLE_PAY_LOGO_WHITE_XML_SOURCE).toBe(
      toolkitFile("Apple_Pay_logo_wht_052819.svg")
    );
  });

  it("renders the untouched toolkit XML with an accessible label", async () => {
    svgXmlCalls.length = 0;
    await render(<ApplePayMark width={44} />);
    expect(svgXmlCalls).toHaveLength(1);
    const call = svgXmlCalls[0];
    expect(call?.xml).toBe(toolkitFile("Apple_Pay_Mark_RGB_041619.svg"));
    expect(call?.accessibilityLabel).toBe("Apple Pay");
  });

  it("keeps the toolkit aspect ratio (size-only transformation)", async () => {
    svgXmlCalls.length = 0;
    await render(<ApplePayMark width={100} />);
    const markCall = svgXmlCalls[0];
    expect(markCall).toBeDefined();
    const ratio = (markCall?.width as number) / (markCall?.height as number);
    expect(ratio).toBeCloseTo(165.52107 / 105.9651, 6);

    svgXmlCalls.length = 0;
    await render(<ApplePayLogo width={117.14} variant="white" />);
    const logoCall = svgXmlCalls[0];
    expect(logoCall?.xml).toBe(toolkitFile("Apple_Pay_logo_wht_052819.svg"));
    expect(logoCall?.height).toBeCloseTo(49.82, 6);
  });
});

describe("Apple Pay mark surface wiring", () => {
  const sourceOf = (rel: string) =>
    readFileSync(path.join(MOBILE_ROOT, rel), "utf8");

  it.each([
    // Payment-method list (buyer-facing acceptance surface).
    "app/(tabs)/pos/cart.tsx",
    // Buyer-facing tap moment on the card charge screen.
    "app/(tabs)/pos/card.tsx",
    // Tap to Pay settings screen (advertises Apple Pay acceptance).
    "app/(tabs)/settings/tap-to-pay.tsx",
    // Awareness marketing pitch (names Apple Pay).
    "components/tap-to-pay-awareness.tsx",
    // Merchant education pager (the wallets slide advertises acceptance).
    "components/tap-to-pay-education.tsx",
  ])("%s renders the shared toolkit mark", (rel) => {
    const source = sourceOf(rel);
    expect(source).toContain("@/components/apple-pay-mark");
    expect(source).toMatch(/<ApplePay(Mark|Logo)\b/);
  });

  it("flags every education slide that advertises Apple Pay acceptance", () => {
    const lib = sourceOf("lib/tap-to-pay-education.ts");
    // The apple-pay-wallets slide claims acceptance; its flag drives the
    // mark in the pager. Guard the pairing so a future slide edit can't
    // drop one half.
    expect(lib).toMatch(/id: "apple-pay-wallets"[\s\S]*?applePayMark: true/);
    expect(sourceOf("components/tap-to-pay-education.tsx")).toContain(
      "slide.applePayMark"
    );
  });

  it("marks the web FAQ's Apple Pay acceptance answer with the toolkit SVG", () => {
    const faq = readFileSync(
      path.join(__dirname, "../../pages/faq/index.tsx"),
      "utf8"
    );
    expect(faq).toContain("/tap-to-pay/logo/Apple_Pay_Mark_RGB_041619.svg");
  });

  it.each([
    "Apple_Pay_Mark_RGB_041619.svg",
    "Apple_Pay_logo_blk_052819.svg",
    "Apple_Pay_logo_wht_052819.svg",
  ])("serves the web copy of %s byte-for-byte unmodified", (name) => {
    const webCopy = readFileSync(
      path.join(__dirname, "../../public/tap-to-pay/logo", name)
    );
    const toolkitCopy = readFileSync(
      path.join(MOBILE_ROOT, "assets/tap-to-pay/logo", name)
    );
    expect(webCopy.equals(toolkitCopy)).toBe(true);
  });
});
