import { useCallback, useEffect, useRef } from "react";
import { useRouter, type Href } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { create } from "zustand";

/**
 * Outcome of a PoS payment (Tap to Pay card, Lightning invoice, or Square
 * checkout) that resolved while the seller was looking at another tab. Tab
 * switches do not unmount the PoS payment screens, so a sale can finish on a
 * screen nobody is watching; this store is the signal the Sell tab badges
 * itself from until the seller returns, the payment screen shows the
 * resolved state, and the flag is cleared.
 *
 * Ephemeral and in-memory only, like the PoS cart: it lives for one register
 * interaction and needs no persistence or pubkey scoping.
 *
 * The screen-side half of this contract (focus tracking, badge set/clear,
 * and the deferred success navigation) lives in usePosUnseenOutcome below,
 * so the three payment screens cannot drift apart on the wiring.
 */
export interface PosUnseenCardOutcome {
  approved: boolean;
  /** Formatted charge amount (e.g. "$12.00") for the outcome signal. */
  amountText: string;
  /** Failure message when the charge did not complete. */
  message?: string;
}

interface PosCardOutcomeStoreState {
  unseenOutcome: PosUnseenCardOutcome | null;
  setUnseenOutcome: (outcome: PosUnseenCardOutcome) => void;
  clearUnseenOutcome: () => void;
}

export const usePosCardOutcomeStore = create<PosCardOutcomeStoreState>(
  (set) => ({
    unseenOutcome: null,
    setUnseenOutcome: (unseenOutcome) => set({ unseenOutcome }),
    clearUnseenOutcome: () => set({ unseenOutcome: null }),
  })
);

/**
 * The tab-switch outcome wiring shared by the three PoS payment screens
 * (card, lightning, square). Tab switches do NOT unmount those screens: a
 * seller who taps another tab mid-payment leaves the sale resolving on a
 * screen nobody is watching. This hook owns the whole contract so a fix
 * lands on every screen at once:
 *
 * - `focusedRef` mirrors useIsFocused so a long async sale chain samples
 *   focus AT COMPLETION, not at payment detection — the seller may switch
 *   tabs during the awaited recording step, and a router.replace must never
 *   fire behind the tab they are looking at.
 * - `deferApprovedOutcome` (unfocused success path) arms the pending marker
 *   synchronously — so the cart-clearing re-render already sees it and the
 *   screen's render gate (`if (pendingOutcomeRef.current) return null`)
 *   stays blank rather than flashing a stale mid-payment state over an
 *   emptied cart — and badges the Sell tab. The success navigation itself
 *   is deferred to the refocus effect below.
 * - `badgeUnseenFailure` (unfocused failure path) badges the Sell tab so a
 *   failed charge is not silently missed; the error state itself waits on
 *   the still-mounted screen for the seller's return.
 * - On refocus the badge clears and, if a payment resolved approved while
 *   the seller was away, the deferred success navigation fires exactly
 *   once, now that the replace lands on the screen they are watching. A
 *   seller who never left gets the immediate replace in the sale flow and
 *   nothing here.
 */
export function usePosUnseenOutcome(options?: {
  /**
   * Runs right before the deferred success navigation fires on refocus. The
   * card screen uses this to arm its charge-in-flight navigation-block
   * pass-through so the block doesn't swallow the replace.
   */
  onDeferredNavigate?: () => void;
}) {
  const router = useRouter();
  const isFocused = useIsFocused();
  const focusedRef = useRef(isFocused);
  useEffect(() => {
    focusedRef.current = isFocused;
  }, [isFocused]);
  const setUnseenOutcome = usePosCardOutcomeStore(
    (state) => state.setUnseenOutcome
  );
  const clearUnseenOutcome = usePosCardOutcomeStore(
    (state) => state.clearUnseenOutcome
  );

  // Set when a payment resolves approved while the seller is on another
  // tab: the success navigation is deferred to the refocus effect below
  // instead of firing router.replace behind the tab they are watching.
  const pendingOutcomeRef = useRef<"approved" | null>(null);

  // Latest-callback ref so the refocus effect below keeps stable deps.
  const onDeferredNavigateRef = useRef(options?.onDeferredNavigate);
  useEffect(() => {
    onDeferredNavigateRef.current = options?.onDeferredNavigate;
  }, [options?.onDeferredNavigate]);

  // The seller came back to the Sell tab: clear the outcome badge and, if
  // a payment resolved approved while they were away, run the deferred
  // success navigation now that the replace lands on the screen they are
  // watching. The pending ref makes the deferred navigation fire exactly
  // once — a seller who never left gets the immediate replace in the sale
  // flow and nothing here.
  useEffect(() => {
    if (!isFocused) return;
    clearUnseenOutcome();
    if (pendingOutcomeRef.current === "approved") {
      pendingOutcomeRef.current = null;
      onDeferredNavigateRef.current?.();
      router.replace("/(tabs)/pos/success" as Href);
    }
  }, [isFocused, clearUnseenOutcome, router]);

  const badgeUnseenFailure = useCallback(
    (amountText: string, message: string) => {
      if (focusedRef.current) return;
      setUnseenOutcome({ approved: false, amountText, message });
    },
    [setUnseenOutcome]
  );

  const deferApprovedOutcome = useCallback(
    (amountText: string) => {
      pendingOutcomeRef.current = "approved";
      setUnseenOutcome({ approved: true, amountText });
    },
    [setUnseenOutcome]
  );

  return {
    focusedRef,
    pendingOutcomeRef,
    badgeUnseenFailure,
    deferApprovedOutcome,
  };
}
