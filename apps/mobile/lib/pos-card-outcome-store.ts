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
