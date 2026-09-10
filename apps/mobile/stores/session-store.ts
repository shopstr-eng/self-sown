import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

import type { SellerSession } from "@self-sown/domain";
import {
  deserializeSellerSession,
  serializeSellerSession,
} from "@self-sown/nostr";

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
  },
  saveSession: async (session) => {
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
    await SecureStore.deleteItemAsync(SELLER_SESSION_STORAGE_KEY);
    set({
      session: null,
      hydrated: true,
    });
  },
}));
