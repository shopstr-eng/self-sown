import AsyncStorage from "@react-native-async-storage/async-storage";

// Apple Tap to Pay on iPhone merchant education:
//
// Req 4.1 (Required in the App & Marketing Requirements and Review Guide,
// enforced in Apple's Nov 2026 entitlement review): on iOS 18+, merchant
// education is Apple's OWN sheet presented via ProximityReaderDiscovery,
// integrated natively in modules/proximity-reader-discovery (the Stripe
// Terminal RN SDK beta.34 does not expose the API; the guide explicitly
// allows integrating it directly alongside the PSP SDK). Apple's sheet
// fulfills 4.4/4.6/4.7/4.8 because Apple owns and localizes the content.
//
// presentAppleTapToPayEducation() is the single entry point. It returns
// false — and the caller then shows the custom screens below — on Android,
// iOS <18 (deployment target is 16.0), web, a build without the native
// module, and any content/presentation error, so education can never
// silently vanish.
//
// The custom slides below remain the education for those fallback cases
// (Req 4.4 conditional path: copy/artwork from the Tap to Pay on iPhone
// Marketing Guide and Toolkit, never self-made iPhone imagery — hero
// provenance: lib/tap-to-pay-artwork.ts; sanctioned copy:
// packages/domain/src/tap-to-pay-marketing-copy.ts).
//
// Coverage: 4.2 (education right after T&C acceptance — wired by the
// awareness moment, Settings enable path, and first checkout connect), 4.3
// (persistent reopen entry in Settings; on iOS 18+ it re-presents Apple's
// sheet), 4.5 (contactless cards), 4.6 (Apple Pay + digital wallets), 4.7
// (PIN entry + PIN-screen accessibility), 4.8 (fallback payment copy,
// verbatim from the guide) — Apple's sheet covers all of it on iOS 18+;
// these slides cover it everywhere else.

import { getProximityReaderDiscoveryModule } from "../modules/proximity-reader-discovery";

/**
 * Presents Apple's own Tap to Pay on iPhone education sheet (Req 4.1).
 * Resolves true only when the sheet was presented and dismissed; false means
 * the caller must fall back to the custom education screens.
 */
export async function presentAppleTapToPayEducation(): Promise<boolean> {
  const discovery = getProximityReaderDiscoveryModule();
  if (!discovery) return false;
  try {
    await discovery.presentEducation();
    return true;
  } catch {
    // iOS <18, missing entitlement/presenter, or a content fetch failure —
    // never propagate: the custom screens are the guaranteed fallback.
    return false;
  }
}

export type TapToPayEducationSlide = {
  id: string;
  title: string;
  body: string;
  // Set when the slide advertises Apple Pay acceptance: Apple's rules then
  // require the approved Apple Pay mark on the slide (toolkit SVG, rendered
  // unmodified — see components/apple-pay-mark.tsx).
  applePayMark?: boolean;
};

export const TAP_TO_PAY_EDUCATION_SLIDES: readonly TapToPayEducationSlide[] = [
  {
    id: "contactless-cards",
    title: "Take contactless cards",
    body:
      "At checkout, choose Tap to Pay on iPhone and ask the customer to " +
      "hold their contactless card horizontally near the top of your " +
      "iPhone. Keep it there until you see the confirmation on screen — " +
      "the card is read in a second or two, and the app then shows whether " +
      "the payment was approved or declined.",
  },
  {
    id: "apple-pay-wallets",
    title: "Take Apple Pay and digital wallets",
    body:
      "Tap to Pay on iPhone also accepts Apple Pay and other digital " +
      "wallets. The customer holds their iPhone or Apple Watch near the " +
      "top of your iPhone and authorizes on their own device — no card " +
      "changes hands.",
    applePayMark: true,
  },
  {
    id: "pin-entry",
    title: "PIN entry and accessibility",
    body:
      "Some cards ask the customer to enter their PIN. When that happens, " +
      "a secure PIN screen appears on your iPhone and the customer enters " +
      "the PIN themselves — hand them the phone or tilt it toward them. " +
      "The PIN screen supports iOS accessibility features such as " +
      "VoiceOver, so customers who use them can enter their PIN " +
      "independently.",
  },
  {
    id: "fallback-payment",
    title: "If a card can't be read",
    // Fallback copy prescribed verbatim by the App & Marketing
    // Requirements guide for custom education screens (Req 4.8).
    body:
      "Some cards are not able to complete contactless transactions using " +
      "a PIN. If this occurs, simply ask the customer if they have an " +
      "alternative contactless card or digital wallet and continue the " +
      "transaction using Tap to Pay on iPhone. You can also switch the " +
      "sale to Lightning, a Square payment link, or cash from the same " +
      "checkout screen.",
  },
];

// Android variants of the slides above. Apple's approved copy, artwork, and
// disclaimer rules bind only on iOS; on Android the same lessons are taught
// with device-neutral wording (no iPhone/Apple Pay/iOS references, so no
// Apple Pay mark or Apple disclaimer rides along). Slide ids match the iOS
// set so pager state, dots, and tests line up across platforms.
export const TAP_TO_PAY_EDUCATION_SLIDES_ANDROID: readonly TapToPayEducationSlide[] =
  [
    {
      id: "contactless-cards",
      title: "Take contactless cards",
      body:
        "At checkout, choose Tap to Pay and ask the customer to " +
        "hold their contactless card near your phone's NFC antenna — " +
        "usually on the back. Keep it there until you see the confirmation " +
        "on screen — the card is read in a second or two, and the app " +
        "then shows whether the payment was approved or declined.",
    },
    {
      id: "digital-wallets",
      title: "Take digital wallets",
      body:
        "Tap to Pay also accepts Google Pay and other digital " +
        "wallets. The customer holds their phone or watch near your " +
        "phone and authorizes on their own device — no card " +
        "changes hands.",
    },
    {
      id: "pin-entry",
      title: "PIN entry and accessibility",
      body:
        "Some cards ask the customer to enter their PIN. When that happens, " +
        "a secure PIN screen appears on your phone and the customer enters " +
        "the PIN themselves — hand them the phone or tilt it toward them. " +
        "The PIN screen supports Android accessibility features such as " +
        "TalkBack, so customers who use them can enter their PIN " +
        "independently.",
    },
    {
      id: "fallback-payment",
      title: "If a card can't be read",
      body:
        "Some cards are not able to complete contactless transactions using " +
        "a PIN. If this occurs, simply ask the customer if they have an " +
        "alternative contactless card or digital wallet and continue the " +
        "transaction using Tap to Pay. You can also switch the " +
        "sale to Lightning, a Square payment link, or cash from the same " +
        "checkout screen.",
    },
  ];

// Picks the slide set for the platform. iOS (and anything unrecognized) gets
// the byte-identical Apple-review slides; Android gets the device-neutral
// set.
export function tapToPayEducationSlidesFor(
  platformOS: string
): readonly TapToPayEducationSlide[] {
  return platformOS === "android"
    ? TAP_TO_PAY_EDUCATION_SLIDES_ANDROID
    : TAP_TO_PAY_EDUCATION_SLIDES;
}

const EDUCATION_STORAGE_PREFIX = "tapToPay:education";
const EDUCATION_SEEN_VALUE = "1";

export function tapToPayEducationStorageKey(pubkey: string): string {
  return `${EDUCATION_STORAGE_PREFIX}:${pubkey}`;
}

// The education shows once after T&C acceptance, per seller pubkey so a
// shared device reaches every account. Reading fails open (show again) and
// writing fails quiet (worst case it shows once more) — education is
// idempotent, so a repeat is harmless.
export async function hasSeenTapToPayEducation(
  pubkey: string
): Promise<boolean> {
  try {
    return (
      (await AsyncStorage.getItem(tapToPayEducationStorageKey(pubkey))) ===
      EDUCATION_SEEN_VALUE
    );
  } catch {
    return false;
  }
}

export async function markTapToPayEducationSeen(pubkey: string): Promise<void> {
  try {
    await AsyncStorage.setItem(
      tapToPayEducationStorageKey(pubkey),
      EDUCATION_SEEN_VALUE
    );
  } catch {
    // Worst case the education shows once more — acceptable.
  }
}

// --- First-charge education gate (Apple checklist 4.2 wiring) ---
//
// The PoS card screen pauses the first charge on this handshake until the
// education modal is dismissed. The pause/resume contract lives here (not in
// the component) so it is unit-testable: a refactor must not let the sale
// proceed without the education, nor hang the sale if the modal's exit path
// stops resolving.

export type TapToPayEducationPauseArgs = {
  pubkey: string | null;
};

export async function shouldShowEducationAfterConnect({
  pubkey,
}: TapToPayEducationPauseArgs): Promise<boolean> {
  // No seller identity → never pause: hanging a sale is worse than a repeat
  // showing (education is idempotent).
  if (!pubkey) return false;
  // The seen flag is the ONLY authority — never skip just because the native
  // SDK reused a live reader connection. A seller whose first checkout
  // connect was cancelled mid-education still has that connection cached, so
  // a connection-reuse skip would let them charge without ever seeing the
  // education. The enablement paths (Settings, awareness moment) mark seen
  // when their education finishes, so a genuinely-educated seller still
  // skips the pause here.
  return !(await hasSeenTapToPayEducation(pubkey));
}

export type TapToPayEducationOutcome = "dismissed" | "cancelled";

export type TapToPayEducationGate = {
  // Resolves when dismiss() or cancel() runs. Call only after showing the
  // modal. "cancelled" means the sale must unwind WITHOUT charging — the
  // screen went away mid-education, so continuing would hang the sale on an
  // unmounted screen (or worse, charge after the seller left). A cancel that
  // lands BEFORE the wait starts (unmount during the async education-seen
  // check) is armed, and the next wait resolves "cancelled" immediately.
  waitForDismissal: () => Promise<TapToPayEducationOutcome>;
  // Modal exit path: persists "seen", releases the paused sale, and clears
  // any armed cancel exactly once. Safe to call again — the resolver is
  // cleared before release, so a stale extra call (e.g. double-tap on done)
  // cannot release a later pause.
  dismiss: (pubkey: string | null) => void;
  // Screen exit path (unmount / back navigation while paused, or while the
  // async education check is still settling): releases the paused sale
  // WITHOUT persisting "seen" — leaving mid-education is not dismissal, so
  // the next first charge pauses on the education again. With no pause
  // pending it arms the NEXT wait once, so a screen exit racing the check
  // cannot leave the sale hanging.
  cancel: () => void;
  isPaused: () => boolean;
};

export function createTapToPayEducationGate(): TapToPayEducationGate {
  let release: ((outcome: TapToPayEducationOutcome) => void) | null = null;
  // Set when cancel() runs with nothing paused: the screen left during the
  // async education-seen check, before waitForDismissal() was called. The
  // next wait consumes the arm and resolves "cancelled" immediately instead
  // of hanging on a modal that is already gone.
  let cancelArmed = false;
  return {
    waitForDismissal() {
      if (cancelArmed) {
        cancelArmed = false;
        return Promise.resolve<TapToPayEducationOutcome>("cancelled");
      }
      return new Promise<TapToPayEducationOutcome>((resolve) => {
        release = resolve;
      });
    },
    dismiss(pubkey) {
      if (pubkey) void markTapToPayEducationSeen(pubkey);
      cancelArmed = false;
      const pending = release;
      release = null;
      pending?.("dismissed");
    },
    cancel() {
      const pending = release;
      release = null;
      if (pending) {
        pending("cancelled");
      } else {
        cancelArmed = true;
      }
    },
    isPaused() {
      return release !== null;
    },
  };
}
