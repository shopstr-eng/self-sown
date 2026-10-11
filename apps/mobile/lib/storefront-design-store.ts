import { create } from "zustand";

import {
  sanitizeStorefrontConfigLinks,
  type SellerSession,
  type SellerShopProfileContent,
  type StorefrontConfig,
} from "@self-sown/domain";
import { publishSellerShopProfile } from "@self-sown/nostr";

import { getApiBaseUrl } from "@/lib/api-base-url";
import { getErrorMessage } from "@/lib/error-utils";

// Single draft of the seller's storefront design config, shared by every
// design editor screen (theme, sections, pages, footer, popup, SEO). Edits
// accumulate here; Save publishes one kind:30019 profile event carrying the
// whole config, so concurrent edits across screens can never clobber each
// other's slices. Links are run through the same domain sanitizer the web
// save path uses before publish.
type StorefrontDesignStore = {
  draft: StorefrontConfig;
  // JSON signature of the config the draft was hydrated from. A profile
  // refetch with a different config replaces the draft only when there are
  // no unsaved edits, so a late-arriving relay copy can't clobber typing.
  hydratedSignature: string | null;
  dirty: boolean;
  saving: boolean;
  saveError: string;
  saveMessage: string;
  hydrate: (config: StorefrontConfig | undefined) => void;
  update: (recipe: (draft: StorefrontConfig) => StorefrontConfig) => void;
  save: (params: {
    session: SellerSession;
    existingContent: SellerShopProfileContent | undefined;
  }) => Promise<boolean>;
};

function signatureOf(config: StorefrontConfig | undefined): string {
  return JSON.stringify(config ?? {});
}

export const useStorefrontDesignStore = create<StorefrontDesignStore>()(
  (set, get) => ({
    draft: {},
    hydratedSignature: null,
    dirty: false,
    saving: false,
    saveError: "",
    saveMessage: "",

    hydrate: (config) => {
      const signature = signatureOf(config);
      const state = get();
      if (state.hydratedSignature === signature) return;
      // Never stomp unsaved edits with a refetch; the seller can save or the
      // next clean hydration applies once dirty clears.
      if (state.dirty) return;
      set({
        draft: config ? { ...config } : {},
        hydratedSignature: signature,
        saveError: "",
        saveMessage: "",
      });
    },

    update: (recipe) => {
      set((state) => ({
        draft: recipe(state.draft),
        dirty: true,
        saveMessage: "",
        saveError: "",
      }));
    },

    save: async ({ session, existingContent }) => {
      if (!existingContent) {
        set({
          saveError:
            "Save your stall basics first — the design lives on the stall profile.",
        });
        return false;
      }
      set({ saving: true, saveError: "", saveMessage: "" });
      const sanitized = sanitizeStorefrontConfigLinks(get().draft);
      const nextContent: SellerShopProfileContent = {
        ...existingContent,
        storefront: sanitized,
      };
      try {
        await publishSellerShopProfile({
          baseUrl: getApiBaseUrl(),
          session,
          content: JSON.stringify(nextContent),
        });
      } catch (caughtError) {
        set({
          saving: false,
          saveError: getErrorMessage(
            caughtError,
            "Storefront design publish failed."
          ),
        });
        return false;
      }
      set({
        saving: false,
        dirty: false,
        draft: sanitized,
        hydratedSignature: signatureOf(sanitized),
        saveMessage: "Design saved. It may take a moment to appear live.",
      });
      return true;
    },
  })
);
