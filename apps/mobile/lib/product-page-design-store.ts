import { create } from "zustand";

import {
  buildProductPageConfig,
  parseProductPageConfig,
  validateProductPageConfig,
  type NostrEventRecord,
  type SellerSession,
  type StorefrontColorScheme,
  type StorefrontProductPageConfig,
  type StorefrontSection,
} from "@self-sown/domain";

import { getErrorMessage } from "@/lib/error-utils";
import { saveSellerListingPageDesign } from "@/lib/seller-listing-actions";

// Per-product page design (the page_config tag on the kind:30402 listing
// event). Mirrors the web's customize-product-page-modal: shop-defaults
// mode stores NO sections, theme overrides are a sparse color map, and the
// SEO fields trim away when empty. Building/validating the payload goes
// through the shared domain helpers so both platforms persist identically.
export type ProductPageDesignDraft = {
  sections: StorefrontSection[];
  useShopDefaults: boolean;
  themeOverrides: Partial<StorefrontColorScheme>;
  metaTitle: string;
  metaDescription: string;
  ogImage: string;
};

const EMPTY_DRAFT: ProductPageDesignDraft = {
  sections: [],
  useShopDefaults: true,
  themeOverrides: {},
  metaTitle: "",
  metaDescription: "",
  ogImage: "",
};

type ProductPageDesignStore = {
  // Event id of the listing this draft belongs to, and the event it was
  // hydrated from (the save path rejects with a stale error if the listing
  // moved on — same guard as the listing editor).
  listingId: string | null;
  baseEvent: NostrEventRecord | null;
  draft: ProductPageDesignDraft;
  hydratedSignature: string | null;
  dirty: boolean;
  saving: boolean;
  saveError: string;
  saveMessage: string;
  hydrate: (event: NostrEventRecord) => void;
  update: (
    recipe: (draft: ProductPageDesignDraft) => ProductPageDesignDraft
  ) => void;
  save: (session: SellerSession) => Promise<boolean>;
};

function signatureOf(config: StorefrontProductPageConfig | undefined): string {
  return JSON.stringify(config ?? null);
}

function draftFromConfig(
  config: StorefrontProductPageConfig | undefined
): ProductPageDesignDraft {
  return {
    sections: config?.sections ?? [],
    useShopDefaults: !(config?.sections && config.sections.length > 0),
    themeOverrides: config?.themeOverrides ?? {},
    metaTitle: config?.metaTitle ?? "",
    metaDescription: config?.metaDescription ?? "",
    ogImage: config?.ogImage ?? "",
  };
}

export const useProductPageDesignStore = create<ProductPageDesignStore>()(
  (set, get) => ({
    listingId: null,
    baseEvent: null,
    draft: EMPTY_DRAFT,
    hydratedSignature: null,
    dirty: false,
    saving: false,
    saveError: "",
    saveMessage: "",

    hydrate: (event) => {
      const config = parseProductPageConfig(event.tags);
      const signature = signatureOf(config);
      const state = get();
      if (state.listingId === event.id) {
        // A refetch of the same listing never stomps unsaved edits, and a
        // matching signature means nothing changed.
        if (state.hydratedSignature === signature || state.dirty) return;
      }
      set({
        listingId: event.id,
        baseEvent: event,
        draft: draftFromConfig(config),
        hydratedSignature: signature,
        dirty: false,
        saveError: "",
        saveMessage: "",
      });
    },

    update: (recipe) =>
      set((state) => ({
        draft: recipe(state.draft),
        dirty: true,
        saveMessage: "",
        saveError: "",
      })),

    save: async (session) => {
      const state = get();
      if (!state.baseEvent) {
        set({
          saveError:
            "This product is still loading — reopen the page design screen.",
        });
        return false;
      }
      const config = buildProductPageConfig({
        sections: state.draft.sections,
        useShopDefaults: state.draft.useShopDefaults,
        themeOverrides: state.draft.themeOverrides,
        metaTitle: state.draft.metaTitle,
        metaDescription: state.draft.metaDescription,
        ogImage: state.draft.ogImage,
      });
      const validationError = validateProductPageConfig(config);
      if (validationError) {
        set({ saveError: validationError });
        return false;
      }
      set({ saving: true, saveError: "", saveMessage: "" });
      try {
        const event = await saveSellerListingPageDesign(
          session,
          state.baseEvent,
          config
        );
        set({
          saving: false,
          dirty: false,
          // The freshly published event becomes the base so a second save
          // isn't rejected as stale.
          baseEvent: event,
          hydratedSignature: signatureOf(config ?? undefined),
          saveMessage:
            "Page design saved. It may take a moment to appear live.",
        });
        return true;
      } catch (error) {
        set({
          saving: false,
          saveError: getErrorMessage(error, "Page design publish failed."),
        });
        return false;
      }
    },
  })
);
