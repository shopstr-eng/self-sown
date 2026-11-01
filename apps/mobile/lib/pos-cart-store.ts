import { create } from "zustand";

import {
  POS_MAX_LINE_QUANTITY,
  posCartLineKey,
  type PosCartLine,
  type PosCatalogItem,
  type PosPaymentMethod,
} from "@self-sown/domain";

// Ephemeral in-memory cart: a register sale is a point-in-time interaction, so
// nothing here persists (and nothing needs pubkey-scoped storage — logging out
// unmounts the tab and drops the state).

export interface PosReceiptLine {
  title: string;
  quantity: number;
  /** Line total in the sale currency (major units / sats), after bulk tiers. */
  total: number;
}

export interface PosCompletedSale {
  saleId: string;
  method: PosPaymentMethod;
  reference: string;
  total: number;
  currency: string;
  itemCount: number;
  /** Priced lines snapshotted at completion — the shareable receipt (5.10). */
  receiptLines: PosReceiptLine[];
  buyerEmail?: string;
}

interface PosCartState {
  lines: PosCartLine[];
  note: string;
  buyerEmail: string;
  /** Sale currently being collected (set when charging starts). */
  activeSaleId: string | null;
  lastCompletedSale: PosCompletedSale | null;

  addItem: (item: PosCatalogItem) => void;
  removeLine: (key: string) => void;
  setQuantity: (key: string, quantity: number) => void;
  setNote: (note: string) => void;
  setBuyerEmail: (email: string) => void;
  beginSale: (saleId: string) => void;
  completeSale: (sale: PosCompletedSale) => void;
  cancelSale: () => void;
  clear: () => void;
}

export const usePosCartStore = create<PosCartState>((set) => ({
  lines: [],
  note: "",
  buyerEmail: "",
  activeSaleId: null,
  lastCompletedSale: null,

  addItem: (item) =>
    set((state) => {
      const key = posCartLineKey(item.address);
      const existing = state.lines.find((line) => line.key === key);
      if (existing) {
        return {
          lines: state.lines.map((line) =>
            line.key === key
              ? {
                  ...line,
                  quantity: Math.min(POS_MAX_LINE_QUANTITY, line.quantity + 1),
                }
              : line
          ),
        };
      }
      return { lines: [...state.lines, { key, item, quantity: 1 }] };
    }),

  removeLine: (key) =>
    set((state) => ({ lines: state.lines.filter((l) => l.key !== key) })),

  setQuantity: (key, quantity) =>
    set((state) => ({
      lines: state.lines
        .map((line) =>
          line.key === key
            ? {
                ...line,
                quantity: Math.max(
                  0,
                  Math.min(POS_MAX_LINE_QUANTITY, Math.floor(quantity))
                ),
              }
            : line
        )
        .filter((line) => line.quantity > 0),
    })),

  setNote: (note) => set({ note }),
  setBuyerEmail: (buyerEmail) => set({ buyerEmail }),
  beginSale: (saleId) => set({ activeSaleId: saleId }),

  completeSale: (sale) =>
    set({
      lastCompletedSale: sale,
      activeSaleId: null,
      lines: [],
      note: "",
      buyerEmail: "",
    }),

  cancelSale: () => set({ activeSaleId: null }),
  clear: () => set({ lines: [], note: "", buyerEmail: "" }),
}));
