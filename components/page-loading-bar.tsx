import { useCallback, useEffect, useRef, useState } from "react";
import Router, { useRouter } from "next/router";

export default function PageLoadingBar() {
  const router = useRouter();
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);

  // Timers/state held in refs so they survive re-renders and so the event
  // subscription effect can stay mounted exactly once (see below).
  const timeouts = useRef<number[]>([]);
  const progressTimer = useRef<number | null>(null);
  // Tracks whether a load is currently in progress. Guards `done()` so it can't
  // double-fire and so the asPath watcher only completes an active bar.
  const activeRef = useRef(false);

  const clearAllTimers = useCallback(() => {
    timeouts.current.forEach((t) => clearTimeout(t));
    timeouts.current = [];
    if (progressTimer.current) {
      clearInterval(progressTimer.current);
      progressTimer.current = null;
    }
  }, []);

  const done = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    clearAllTimers();
    setWidth(100);

    const fade = window.setTimeout(() => {
      setFadeOut(true);
      const hide = window.setTimeout(() => {
        setVisible(false);
        setWidth(0);
        setFadeOut(false);
      }, 300);
      timeouts.current.push(hide);
    }, 150);
    timeouts.current.push(fade);
  }, [clearAllTimers]);

  const start = useCallback(() => {
    clearAllTimers();
    activeRef.current = true;
    setFadeOut(false);
    setVisible(true);
    setWidth(0);

    // Quickly advance to ~15% then slowly crawl toward 85%
    timeouts.current.push(window.setTimeout(() => setWidth(15), 50));
    timeouts.current.push(window.setTimeout(() => setWidth(35), 200));
    timeouts.current.push(window.setTimeout(() => setWidth(55), 500));

    // Slowly inch toward 85% to signal "still loading"
    let current = 55;
    progressTimer.current = window.setInterval(() => {
      if (current < 85) {
        current += Math.random() * 3;
        setWidth(Math.min(current, 85));
      }
    }, 400);

    // Safety timeout: always clear the bar even if no completion signal ever
    // reaches us (e.g. same-route navigation or App Router transitions).
    timeouts.current.push(window.setTimeout(() => done(), 8000));
  }, [clearAllTimers, done]);

  // Subscribe to the Router SINGLETON exactly once. Using `useRouter()` here is
  // a trap: its identity changes as `asPath` updates mid-navigation, which tears
  // down and rebuilds this effect — dropping the in-flight safety timer and
  // sometimes missing the `routeChangeComplete` event, leaving the bar stuck.
  // The singleton's event emitter is stable for the life of the app.
  useEffect(() => {
    const error = () => done();

    Router.events.on("routeChangeStart", start);
    Router.events.on("routeChangeComplete", done);
    Router.events.on("routeChangeError", error);
    Router.events.on("hashChangeStart", start);
    Router.events.on("hashChangeComplete", done);

    return () => {
      Router.events.off("routeChangeStart", start);
      Router.events.off("routeChangeComplete", done);
      Router.events.off("routeChangeError", error);
      Router.events.off("hashChangeStart", start);
      Router.events.off("hashChangeComplete", done);
      clearAllTimers();
    };
  }, [start, done, clearAllTimers]);

  // Authoritative completion: when the committed URL actually changes, the
  // navigation finished — force the bar closed even if the matching
  // `routeChangeComplete` event was never delivered to us.
  useEffect(() => {
    if (activeRef.current) done();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.asPath]);

  if (!visible) return null;

  return (
    <div
      className="pointer-events-none fixed top-0 right-0 left-0 z-[9999] h-[3px]"
      style={{
        opacity: fadeOut ? 0 : 1,
        transition: fadeOut ? "opacity 0.3s ease" : "none",
      }}
    >
      <div
        className="h-full bg-gradient-to-r from-orange-500 to-orange-400"
        style={{
          width: `${width}%`,
          boxShadow: "0 0 8px rgba(249, 115, 22, 0.7)",
          transition:
            width === 100
              ? "width 0.2s ease"
              : "width 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      />
    </div>
  );
}
