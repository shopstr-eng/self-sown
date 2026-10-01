import { useEffect, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { BLACKBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";

// Dismissable announcement for the homestead news. Dismissal persists in
// localStorage so returning visitors aren't nagged on every load. The copy is
// a <p>, never a heading — banners stay out of the page's heading outline.
const DISMISS_KEY = "selfsown-homestead-banner-dismissed";

export default function HomesteadBanner() {
  // Hidden during SSR/first paint: the dismissal flag lives in localStorage,
  // so visibility is only decided after mount (avoids hydration mismatch).
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(DISMISS_KEY)) setVisible(true);
    } catch {
      // Storage blocked: still show; dismissal just won't persist.
      setVisible(true);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible]);

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Non-persistent dismissal is fine.
    }
  };

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Announcement"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-4"
    >
      <div className="shadow-neo pointer-events-auto flex w-full max-w-xl flex-col items-center gap-3 rounded-lg border-2 border-black bg-white p-4 sm:flex-row">
        <p className="flex-1 text-center text-sm font-bold text-black sm:text-left">
          We bought a homestead! Follow our channel to be a part of the journey.
        </p>
        <a href="#videos" className={`${BLACKBUTTONCLASSNAMES} shrink-0`}>
          Follow the journey
        </a>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss announcement"
          className="shadow-neo shrink-0 rounded-md border-2 border-black bg-white p-1 text-black transition-transform hover:-translate-y-0.5 active:translate-y-0 active:shadow-none"
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
