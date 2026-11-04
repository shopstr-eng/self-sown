import { useRouter } from "next/router";
import { WHITEBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import {
  APPLE_PAY_SERVICE_DISCLAIMER,
  TAP_TO_PAY_CONTACTLESS_SYMBOL_DISCLAIMER,
  TAP_TO_PAY_COPY_BLOCKS,
  TAP_TO_PAY_FULL_DISCLAIMER,
  TAP_TO_PAY_HOW_TO_USE,
} from "@self-sown/domain";

// The Tap to Pay on iPhone product page. Apple's marketing rules allow the
// short "Terms apply." disclaimer in tight placements ONLY because it clicks
// through to a product page like this one showing the full disclaimer — so
// the Legal section below is the load-bearing part of this page, and the copy
// above it stays within Apple's approved copy blocks (placeholders filled,
// which Apple explicitly permits; the launch-window "[now]" phrasing has been
// stripped from the source blocks). The sanctioned copy + disclaimers
// live in packages/domain/src/tap-to-pay-marketing-copy.ts — import, never
// retype, so this page can't drift from the approved text.

const VALUE_PROP = TAP_TO_PAY_COPY_BLOCKS.find(
  (block) => block.theme === "Value proposition"
);

function fillPlaceholders(copy: string): string {
  return copy
    .replace("[partner product]", "the Self-sown app")
    .replace(/\[partner name\]/g, "Self-sown")
    .replace("[terminals/readers]", "terminals")
    .replace(
      "[define next step, such as entering the purchase amount or selecting a specific option within the app]",
      "enter the purchase amount"
    );
}

const HERO_COPY = fillPlaceholders(VALUE_PROP?.longCopy ?? "");
const HOW_TO_STEPS =
  TAP_TO_PAY_HOW_TO_USE.contactlessCard.map(fillPlaceholders);

const LEGAL_NOTICES = [
  TAP_TO_PAY_FULL_DISCLAIMER,
  // The how-to steps reference the Contactless Symbol, so the EMVCo notice is
  // required alongside them.
  TAP_TO_PAY_CONTACTLESS_SYMBOL_DISCLAIMER,
  // The page names Apple Pay, so the Apple Pay service disclaimer is required.
  APPLE_PAY_SERVICE_DISCLAIMER,
];

export default function TapToPay() {
  const router = useRouter();

  return (
    <div className="bg-grid-pattern flex min-h-screen flex-col bg-white py-8 md:pb-20">
      <div className="container mx-auto max-w-4xl px-4">
        <div className="mb-12">
          <button
            onClick={() => router.back()}
            className={`${WHITEBUTTONCLASSNAMES} mb-8 flex items-center gap-2`}
          >
            <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
            Back
          </button>
          <h1 className="text-center text-5xl font-bold text-black">
            {VALUE_PROP?.headline ?? "Tap to Pay on iPhone"}
          </h1>
          <p className="mt-4 text-center text-lg text-zinc-600">
            {VALUE_PROP?.subheadlines[0]}
          </p>
        </div>

        <div className="space-y-6">
          <div className="shadow-neo rounded-lg border-2 border-black bg-white p-6">
            <p className="leading-relaxed text-zinc-700">{HERO_COPY}</p>
            {/* The approved Apple Pay acceptance mark from the Tap to Pay on
                iPhone Marketing Toolkit; only its rendered size is ours (no
                crop/recolor/overlay). */}
            {}
            <img
              src="/tap-to-pay/logo/Apple_Pay_Mark_RGB_041619.svg"
              alt="Apple Pay"
              width={44}
              className="mt-4 h-auto"
            />
          </div>

          <div className="shadow-neo rounded-lg border-2 border-black bg-white p-6">
            <h2 className="mb-2 text-lg font-bold text-black">How to use it</h2>
            <ol className="list-decimal space-y-2 pl-5 leading-relaxed text-zinc-700">
              {HOW_TO_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>

          {/* Apple's required legal notices. The full disclaimer MUST stay on
              this page: every short-form "Terms apply." placement (in-app,
              push, SEO) clicks through to here. */}
          <div className="shadow-neo rounded-lg border-2 border-black bg-white p-6">
            <h2 className="mb-2 text-lg font-bold text-black">Legal</h2>
            <div className="space-y-3">
              {LEGAL_NOTICES.map((notice) => (
                <p
                  key={notice}
                  className="text-sm leading-relaxed text-zinc-500"
                >
                  {notice}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
