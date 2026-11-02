/** @jest-environment node */

// Component test for the Tap to Pay disclaimer footer — the piece that makes
// the short "Terms apply." form legal in tight placements: it must render on
// every marketing/education screen and click through to the Tap to Pay on
// iPhone product page, which shows the full disclaimer. Also guards the
// Apple Pay service disclaimer appearing exactly when the surrounding copy
// names Apple Pay.
//
// Harness pattern mirrors tap-to-pay-education-modal.test.tsx (host-string
// react-native mocks + require()d component so the "@/..." mobile aliases
// stay out of the root tsc program).

import React from "react";

jest.mock(
  "react-native",
  () => ({
    Pressable: "Pressable",
    View: "View",
    Text: "Text",
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten: (style: unknown) => style,
    },
  }),
  { virtual: true }
);

const openBrowserAsync = jest.fn(async () => ({}));
jest.mock("expo-web-browser", () => ({ openBrowserAsync }), { virtual: true });

jest.mock(
  "../../lib/api-base-url",
  () => ({ getApiBaseUrl: () => "https://self-sown.com" }),
  { virtual: true }
);

jest.mock(
  "../../lib/tap-to-pay-marketing-copy",
  () => jest.requireActual("../../apps/mobile/lib/tap-to-pay-marketing-copy"),
  { virtual: true }
);

jest.mock(
  "../../theme/tokens",
  () => ({
    sellerFonts: { regular: "Test-Regular", semibold: "Test-Semibold" },
    sellerThemeTokens: { primary: "#00aa00", mutedText: "#888888" },
  }),
  { virtual: true }
);

import {
  APPLE_PAY_SERVICE_DISCLAIMER,
  TAP_TO_PAY_PRODUCT_PAGE_PATH,
  TAP_TO_PAY_SHORT_DISCLAIMER,
} from "../../apps/mobile/lib/tap-to-pay-marketing-copy";

const { render, fireEvent } =
  require("@testing-library/react-native") as typeof import("@testing-library/react-native");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TapToPayDisclaimerFooter } =
  require("../../apps/mobile/components/tap-to-pay-disclaimer") as {
    TapToPayDisclaimerFooter: (props: {
      mentionsApplePay?: boolean;
    }) => React.JSX.Element;
  };

describe("TapToPayDisclaimerFooter", () => {
  beforeEach(() => {
    openBrowserAsync.mockClear();
  });

  it("renders the short disclaimer and clicks through to the product page", async () => {
    const app = await render(<TapToPayDisclaimerFooter />);

    const link = app.getByText(TAP_TO_PAY_SHORT_DISCLAIMER);
    expect(link).toBeTruthy();

    await fireEvent.press(link);
    // The click-through target is what makes the short form compliant: it
    // must be the product page (which renders the full disclaimer), on the
    // platform origin the app is built against.
    expect(openBrowserAsync).toHaveBeenCalledTimes(1);
    expect(openBrowserAsync).toHaveBeenCalledWith(
      `https://self-sown.com${TAP_TO_PAY_PRODUCT_PAGE_PATH}`
    );
  });

  it("marks the short disclaimer as a link whose label promises the full terms", async () => {
    const app = await render(<TapToPayDisclaimerFooter />);
    const link = app.getByText(TAP_TO_PAY_SHORT_DISCLAIMER);
    // VoiceOver users must hear this as a link to the terms, not bare text.
    const pressable = app.getByLabelText(/full terms/i);
    expect(pressable.props.accessibilityRole).toBe("link");
    expect(link).toBeTruthy();
  });

  it("omits the Apple Pay service disclaimer by default", async () => {
    const app = await render(<TapToPayDisclaimerFooter />);
    expect(app.queryByText(APPLE_PAY_SERVICE_DISCLAIMER)).toBeNull();
  });

  it("renders the Apple Pay service disclaimer when the placement names Apple Pay", async () => {
    const app = await render(<TapToPayDisclaimerFooter mentionsApplePay />);
    expect(app.getByText(APPLE_PAY_SERVICE_DISCLAIMER)).toBeTruthy();
  });

  it("still shows the short disclaimer when opening the browser fails", async () => {
    openBrowserAsync.mockRejectedValueOnce(new Error("no browser"));
    const app = await render(<TapToPayDisclaimerFooter />);
    const link = app.getByText(TAP_TO_PAY_SHORT_DISCLAIMER);
    await fireEvent.press(link);
    // The rejection is swallowed (non-fatal); the text stays on screen.
    expect(app.getByText(TAP_TO_PAY_SHORT_DISCLAIMER)).toBeTruthy();
  });
});
