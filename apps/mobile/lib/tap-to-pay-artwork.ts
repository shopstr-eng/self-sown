// Apple-approved Tap to Pay on iPhone hero artwork, shared by the awareness
// moment and the merchant education pager so both slots always show the same
// sanctioned image.
//
// Req 4.4: never ship self-made imagery of an iPhone. This hero is Apple's
// own Tap to Pay on iPhone artwork from the regional Tap to Pay on iPhone
// Marketing Toolkit (the entitlement-gated download Apple sends to the
// account holder): US-EN > Product Assets > Composed Images > iOS 26 >
// screen-resolution "Generic Card + iPhone, Hands, Vertical" composition,
// flattened from the toolkit PSD to assets/tap-to-pay/hero.jpg. Do not
// crop, recolor, or overlay the artwork — Apple's marketing rules forbid
// modifying the approved assets.

// Metro resolves bundled image assets through require(); there is no static
// import form for them.
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const TAP_TO_PAY_HERO_IMAGE =
  require("../assets/tap-to-pay/hero.jpg") as number;

export const TAP_TO_PAY_HERO_ACCESSIBILITY_LABEL =
  "A customer holding a contactless card near the top of a merchant's iPhone";

// The hero is iPhone-only artwork: Apple's review mandates it on iOS, and
// Apple's branding rules make iPhone imagery wrong on Android (which has no
// artwork requirement). Android screens render no hero at all — branch here
// so both placements (awareness moment, education pager) decide identically.
export function tapToPayHeroArtwork(
  platformOS: string
): { image: number; accessibilityLabel: string } | null {
  if (platformOS === "android") return null;
  return {
    image: TAP_TO_PAY_HERO_IMAGE,
    accessibilityLabel: TAP_TO_PAY_HERO_ACCESSIBILITY_LABEL,
  };
}
