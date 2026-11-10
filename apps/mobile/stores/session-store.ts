import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

import type { SellerSession } from "@self-sown/domain";
import {
  deserializeSellerSession,
  serializeSellerSession,
} from "@self-sown/nostr";

import { prepareSellerSessionChange } from "../lib/session-lifecycle";
import { usePosCartStore } from "../lib/pos-cart-store";

const SELLER_SESSION_STORAGE_KEY = "self-sown-seller-session";

type SessionStoreState = {
  hydrated: boolean;
  session: SellerSession | null;
  hydrate: () => Promise<void>;
  saveSession: (session: SellerSession) => Promise<void>;
  clearSession: () => Promise<void>;
};

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  hydrated: false,
  session: null,
  hydrate: async () => {
    if (get().hydrated) {
      return;
    }

    try {
      const rawSession = await SecureStore.getItemAsync(
        SELLER_SESSION_STORAGE_KEY
      );
      const session = rawSession ? deserializeSellerSession(rawSession) : null;

      if (rawSession && !session) {
        await SecureStore.deleteItemAsync(SELLER_SESSION_STORAGE_KEY);
      }

      set({
        hydrated: true,
        session,
      });
    } catch (error) {
      set({
        hydrated: true,
        session: null,
      });
      throw error;
    }
  },
  saveSession: async (session) => {
    if (get().session && get().session?.pubkey !== session.pubkey)
      await prepareSellerSessionChange();
    await SecureStore.setItemAsync(
      SELLER_SESSION_STORAGE_KEY,
      serializeSellerSession(session)
    );
    set({
      hydrated: true,
      session,
    });
  },
  clearSession: async () => {
    await prepareSellerSessionChange();
    await SecureStore.deleteItemAsync(SELLER_SESSION_STORAGE_KEY);
    // The PoS cart is a module-global store, so it survives the tab unmount —
    // wipe it or the next seller on a shared device sees the previous cart and
    // the previous buyer's receipt/email.
    usePosCartStore.getState().resetAll();
    set({
      session: null,
      hydrated: true,
    });
  },
}));
