// Apple-approved Tap to Pay on iPhone hero artwork, shared by the awareness
// moment and the merchant education pager so both slots always show the same
// sanctioned image.
//
// Req 4.4: never ship self-made imagery of an iPhone. This hero is Apple's
// own Tap to Pay on iPhone artwork, downloaded from Apple's public developer
// page (developer.apple.com/tap-to-pay, the screen-hero asset) into
// assets/tap-to-pay/hero.jpg. The regional Marketing Toolkit asset (an
// entitlement-gated download sent to the Apple Developer account holder) can
// replace that file without touching this module or the screens. Do not
// crop, recolor, or overlay the artwork — Apple's marketing rules forbid
// modifying the approved assets.

// Metro resolves bundled image assets through require(); there is no static
// import form for them.
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const TAP_TO_PAY_HERO_IMAGE = require("../assets/tap-to-pay/hero.jpg") as number;

export const TAP_TO_PAY_HERO_ACCESSIBILITY_LABEL =
  "A customer holding a contactless card near the top of a merchant's iPhone";
