import AsyncStorage from "@react-native-async-storage/async-storage";

// Apple Tap to Pay on iPhone merchant education (checklist v1.8, section
// "Educating merchants"):
//
// DECISION (Req 4.1): we do NOT integrate Apple's ProximityReaderDiscovery
// API. @stripe/stripe-terminal-react-native beta.34 does not expose it, and
// the guide's alternative — a native module integrated alongside the PSP SDK
// — would mean a custom Expo config plugin + Swift wrapper just for
// education. Apple explicitly permits custom education screens instead (Req
// 4.4 conditional path), provided the copy/assets come from the Tap to Pay on
// iPhone Marketing Guide and Toolkit and we never ship self-made imagery of
// an iPhone. The screens below are text-only for that reason; Apple-approved
// toolkit artwork can replace the text hero without changing this flow.
//
// Coverage: 4.2 (shown right after T&C acceptance — wired by the awareness
// moment, Settings enable path, and first checkout connect), 4.3 (persistent
// reopen entry in Settings), 4.5 (contactless cards), 4.6 (Apple Pay +
// digital wallets), 4.7 (PIN entry + PIN-screen accessibility — required in
// every region except JP/TW, and the app deploys in the US), and 4.8
// (fallback payment method copy, verbatim from the guide where Apple
// prescribes it).

export type TapToPayEducationSlide = {
  id: string;
  title: string;
  body: string;
};

export const TAP_TO_PAY_EDUCATION_SLIDES: readonly TapToPayEducationSlide[] =
  [
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

export async function markTapToPayEducationSeen(
  pubkey: string
): Promise<void> {
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
