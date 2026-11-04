// Apple-approved Tap to Pay on iPhone marketing copy and legal disclaimers.
//
// Provenance: Tap to Pay on iPhone Marketing Toolkit (the entitlement-gated
// Box share Apple sends to the Apple Developer Account Holder), US-EN >
// Marketing Guide & Copy Blocks > "Tap to Pay on iPhone Marketing Guide Copy
// and Legal Disclaimers — U.S." (Sept 2026). The sanctioned source docx is
// kept at attached_assets/
// Tap_to_Pay_on_iPhone_Marketing_Copy_US_SEPT_2026_nr_09112026.docx (a
// gitignored uploads dir — re-fetch from the Box share if it's missing); the
// toolkit's full Marketing Guide PDF and print/video assets live on the same
// Box share (see .agents/memory/apple-box-toolkit-downloads.md for how to
// re-fetch).
//
// Apple's marketing rules: use these copy blocks verbatim apart from the
// bracketed [partner name]/[partner product]/[offer] placeholders, pair every
// placement with the applicable legal disclaimer below, and never crop,
// recolor, or overlay the approved artwork/logos. Bracketed [now] may only be
// used from launch through the first six months, then must be removed (see
// TAP_TO_PAY_LAUNCH_DATE / isTapToPayNowPhrasingPermitted below).
//
// Logo/badge assets from the same toolkit live beside the hero artwork:
//   assets/tap-to-pay/logo/Apple_Pay_Mark_RGB_041619.svg   — Apple Pay mark
//   assets/tap-to-pay/logo/Apple_Pay_logo_blk_052819.svg   — Apple Pay lockup (black)
//   assets/tap-to-pay/logo/Apple_Pay_logo_wht_052819.svg   — Apple Pay lockup (white)
// (EPS print variants and the Apple Wallet icon TIFFs are in the toolkit's
// Product Assets > Logo and Icon folder on Box.)

// --- [now] phrasing window ---
// Apple's rule: bracketed [now] phrasing ("Tap to Pay on iPhone is now
// available…") is permitted from launch through the first six months, then
// must be removed from every placement that shipped it.

// The day Tap to Pay on iPhone launch marketing first shipped (the approved
// copy blocks and the launch email both went out with the feature). Kept as
// an ISO date so the six-month window is auditable at a glance.
export const TAP_TO_PAY_LAUNCH_DATE = "2026-11-02";

// First day the [now] phrasing is NO LONGER permitted: exactly six months
// after TAP_TO_PAY_LAUNCH_DATE.
export const TAP_TO_PAY_NOW_PHRASING_ENDS = "2027-05-02";

// True while Apple still permits the bracketed [now] phrasing. Once this
// returns false, every shipped "[now]"/"now available" phrasing must be
// removed or swapped for a non-dated approved variant — the drift-guard test
// in __tests__/mobile/tap-to-pay-marketing-copy.test.ts fails until it is.
export function isTapToPayNowPhrasingPermitted(at: Date = new Date()): boolean {
  return at.getTime() < Date.parse(`${TAP_TO_PAY_NOW_PHRASING_ENDS}T00:00:00Z`);
}

// --- Legal disclaimers ---
// Apple's rule: the disclaimers must accompany ALL advertising. Where space is
// limited the short disclaimer may be used, but it must click through to a
// Tap to Pay on iPhone product page showing the full disclaimer.

export const TAP_TO_PAY_SHORT_DISCLAIMER = "Terms apply.";

// The product page the short disclaimer clicks through to. It displays
// TAP_TO_PAY_FULL_DISCLAIMER (plus the mark/Apple Pay notices below), which
// is what makes the short form legal in tight placements — in-app modals
// link here, and every web/push/SEO placement that carries "Terms apply."
// resolves to this page. Keep it registered in the marketing-page surfaces
// (sitemap, agent-view, meta, llms.txt) like any other top-level page.
export const TAP_TO_PAY_PRODUCT_PAGE_PATH = "/tap-to-pay";

export const TAP_TO_PAY_FULL_DISCLAIMER =
  "Tap to Pay on iPhone requires a supported payment app and the latest " +
  "version of iOS. Update to the latest version by going to Settings > " +
  "General > Software Update. Some contactless cards may not be accepted by " +
  "your payment app. Transaction limits may apply. Tap to Pay on iPhone is " +
  "not available in all markets. For Tap to Pay on iPhone countries and " +
  "regions, see https://developer.apple.com/tap-to-pay/regions/.";

// Additional disclaimers required when specific marks/copy appear:
export const TAP_TO_PAY_CONTACTLESS_INDICATOR_DISCLAIMER =
  "The Contactless Indicator mark, consisting of four graduating arcs, is a " +
  "trademark owned by and used with permission of EMVCo, LLC.";

export const TAP_TO_PAY_CONTACTLESS_SYMBOL_DISCLAIMER =
  "The Contactless Symbol is a trademark owned by and used with permission " +
  "of EMVCo, LLC.";

// Required when the "Apple doesn’t store card numbers on Apple servers" copy
// block is used (see the asterisked blocks below):
export const TAP_TO_PAY_CARD_STORAGE_DISCLAIMER =
  "*Encrypted card numbers are temporarily stored on iPhone only for " +
  "transactions made in Store and Forward mode.";

// Required whenever "Apple Pay" is mentioned:
export const APPLE_PAY_SERVICE_DISCLAIMER =
  "Apple Pay is a service provided by Apple Payments Services LLC, a " +
  "subsidiary of Apple Inc. Neither Apple Inc. nor Apple Payments Services " +
  "LLC is a bank. Any card used in Apple Pay is offered by the card issuer.";

// --- Approved copy blocks ---
// Each block is one of Apple's themes. headline is always
// "Tap to Pay on iPhone"; pick a subheadline + advertising/long copy from the
// same theme. Square brackets are Apple's placeholders.

export type TapToPayCopyBlock = {
  theme: string;
  headline: string;
  subheadlines: readonly string[];
  advertisingCopy: readonly string[];
  longCopy?: string;
};

export const TAP_TO_PAY_COPY_BLOCKS: readonly TapToPayCopyBlock[] = [
  {
    theme: "Value proposition",
    headline: "Tap to Pay on iPhone",
    subheadlines: [
      "Accept contactless payments right on your iPhone.",
      "Accept in-person payments right on your iPhone.",
      "iPhone lets you accept contactless payments.",
      "Use iPhone to accept contactless payments.",
      "Accept physical debit and credit cards as well as Apple Pay and other digital wallets. Right on your iPhone.",
      "For a limited time, get [partner offer] when you start using Tap to Pay on iPhone.",
    ],
    advertisingCopy: [
      "Tap to Pay on iPhone is available with [partner product]. That means you can accept all types of in-person, contactless payments—from physical debit and credit cards to Apple Pay and other digital wallets. Right on your iPhone.",
      "Tap to Pay on iPhone works with physical debit and credit cards, as well as Apple Pay and other digital wallets. Just open the [partner name] app and present your iPhone to the customer.",
      "Get [offer] when you enable Tap to Pay on iPhone. Start accepting contactless payments today.",
      "Get [offer] when you enable Tap to Pay on iPhone. Start accepting in-person, contactless payments in store and on the go.",
      "[Holiday/season] is here. Use Tap to Pay on iPhone to reach more customers, take payments on the go, and explore new setups, like line busting.",
    ],
    longCopy:
      "Tap to Pay on iPhone is available with [partner product]. That means you can accept all types of in-person, contactless payments—from physical debit and credit cards to Apple Pay and other digital wallets. Right on your iPhone. No extra [terminals/readers] or hardware needed. It’s easy, secure, and private.",
  },
  {
    theme: "Enhanced experience",
    headline: "Tap to Pay on iPhone",
    subheadlines: [
      "Do business in more places.",
      "Expand where you do business.",
      "Reach new customers.",
      "Explore new setups, like line busting.",
      "Reach new customers in more places and provide a simpler checkout experience—right on your iPhone.",
    ],
    advertisingCopy: [
      "With Tap to Pay on iPhone, you can accept all types of in-person, contactless payments right on your iPhone so you can reach more customers, take payments on the go, and explore new setups, like line busting.",
      "Reach more customers, accept payments on the go, and explore new setups, like line busting. All you need is your iPhone.",
    ],
    longCopy:
      "With Tap to Pay on iPhone, you can accept all types of in-person, contactless payments right on your iPhone and expand how and where you do business. Reach new customers with a simpler checkout experience, take payments on the go, and explore new setups, like line busting. All you need is your iPhone and the [partner name] app. No extra hardware needed.",
  },
  {
    theme: "Streamlined business",
    headline: "Tap to Pay on iPhone",
    subheadlines: [
      "No terminal needed.",
      "No additional hardware required.",
      "Streamline checkout.",
      "Streamline checkout with no additional hardware.",
      "Easy to implement. Easy to manage.",
      "Accept contactless payments right on your iPhone—no additional hardware required.",
      "Streamline and expand your business.",
    ],
    advertisingCopy: [
      "With Tap to Pay on iPhone, you can accept in-person, contactless payments right on your iPhone. There’s no need for additional card readers or terminals. All you need is your iPhone and the [partner name] app.",
      "Tap to Pay on iPhone is easy to set up and use. No card readers or terminals required.",
      "With Tap to Pay on iPhone, there's no need for additional card readers and terminals. All you need is your iPhone and the [partner name] app.",
    ],
    longCopy:
      "Whether you are starting a new business or looking to expand, Tap to Pay on iPhone allows you to accept all types of in-person, contactless payments right on your iPhone. So there's no need to invest in or manage card readers and terminals. All you need is your iPhone and the [partner name] app.",
  },
  {
    theme: "Easy (merchants)",
    headline: "Tap to Pay on iPhone",
    subheadlines: [
      "Getting started is easy.",
      "Accepting payments is easy.",
      "Get started in a few steps.",
      "Get started in the [partner name] app.",
      "Try it today.",
    ],
    advertisingCopy: [
      "To use Tap to Pay on iPhone, simply download the [partner name] app, sign up, and start accepting in-person, contactless payments anytime, anywhere—right on your iPhone.",
    ],
    longCopy:
      "To use Tap to Pay on iPhone, simply download the [partner name] app, sign up, and start accepting in-person, contactless payments anytime, anywhere—right on your iPhone. No extra terminals or hardware needed.",
  },
  {
    theme: "Privacy and security",
    headline: "Tap to Pay on iPhone",
    subheadlines: [
      "Privacy and security of iPhone built in.",
      "Designed to be secure.",
      "Accept payments with the security of iPhone.",
    ],
    advertisingCopy: [
      // The trailing asterisk binds TAP_TO_PAY_CARD_STORAGE_DISCLAIMER.
      "Apple doesn’t store card numbers on Apple servers, helping protect your business and customer data.*",
    ],
    longCopy:
      "Tap to Pay on iPhone uses the built-in security and privacy features of iPhone to help protect your business and customer data. Apple doesn’t store card numbers on Apple servers, so merchants and customers can rest assured that their data stays theirs.*",
  },
  {
    theme: "No recording",
    headline: "Tap to Pay on iPhone",
    subheadlines: ["No recording."],
    advertisingCopy: [
      "Tap to Pay on iPhone is designed to prevent all photo, video, screenshot, and screen-recording features from capturing a customer’s card number.",
    ],
    longCopy:
      "When a payment is processed, Tap to Pay on iPhone is designed to prevent all photo, video, screenshot, and screen-recording features from capturing a customer’s card number.",
  },
];

// Apple's approved "How to use" step copy (present your iPhone to the
// customer; card held horizontally / device held over the Contactless Symbol;
// Done checkmark completes the read).
export const TAP_TO_PAY_HOW_TO_USE = {
  contactlessCard: [
    "Open the [partner name] app on your iPhone, and [define next step, such as entering the purchase amount or selecting a specific option within the app].",
    "Present your iPhone to the customer.",
    "Your customer holds their card horizontally at the top of your iPhone, over the Contactless Symbol for a few seconds.",
    "When you see the Done checkmark, the card read is complete and the transaction is being processed.",
  ],
  digitalWallet: [
    "Open the [partner name] app on your iPhone, and [define next step, such as entering the purchase amount or selecting a specific option within the app].",
    "Present your iPhone to the customer.",
    "Your customer holds their device at the top of your iPhone, over the Contactless Symbol for a few seconds.",
    "When you see the Done checkmark, the card read is complete and the transaction is being processed.",
  ],
} as const;

export const TAP_TO_PAY_CTA_COPY = [
  "Learn more",
  "Enable now",
  "Try it today",
  "Download the app to get started",
  "Get started with Tap to Pay on iPhone",
  "Get started",
] as const;

// SEO + push notification copy (each placement pairs with the short
// disclaimer "Terms apply." per Apple's rules).
export const TAP_TO_PAY_SEO_COPY = [
  {
    headline: "Tap to Pay on iPhone. Accept contactless payments.",
    body: "With Tap to Pay on iPhone, you can accept all types of contactless payments in the [partner name] app—from physical debit and credit cards to Apple Pay and other digital wallets. Terms apply.",
  },
  {
    headline: "Tap to Pay on iPhone. Do business in more places.",
    body: "With Tap to Pay on iPhone, you can accept contactless payments right on your iPhone in the [partner name] app and reach more customers with new setups, like line busting. Terms apply.",
  },
  {
    headline: "Tap to Pay on iPhone. No terminal needed.",
    body: "Add Tap to Pay on iPhone and accept contactless payments right on your iPhone in the [partner name] app—no additional hardware required. It’s easy and secure. Terms apply.",
  },
] as const;

export const TAP_TO_PAY_PUSH_COPY = [
  {
    headline: "Accept in-person payments with Tap to Pay on iPhone.",
    body: "Accept in-person, contactless payments right on your iPhone, from physical debit and credit cards to Apple Pay and other digital wallets. Terms apply.",
  },
  {
    headline: "Grow your business with Tap to Pay on iPhone.",
    body: "Accept contactless payments right on your iPhone and reach more customers on the go—no extra hardware needed. Terms apply.",
  },
  {
    headline: "Tap to Pay on iPhone. No extra hardware needed.",
    body: "Accept all types of contactless payments right on your iPhone—no need to invest in or manage card readers and terminals. Terms apply.",
  },
  {
    headline: "Enable Tap to Pay on iPhone today.",
    body: "Accept all types of contactless payments right on your iPhone. No extra [terminals/card readers] or hardware needed. Terms apply.",
  },
  {
    headline: "Reach new customers with Tap to Pay on iPhone.",
    body: "Accept your first contactless payment right on your iPhone—wherever you do business. Terms apply.",
  },
] as const;
