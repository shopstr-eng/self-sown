import { createContext, useContext } from "react";

export type StorefrontBranding = {
  shopName?: string | null;
  logoUrl?: string | null;
};

const StorefrontBrandingContext = createContext<StorefrontBranding | null>(
  null
);

export function StorefrontBrandingProvider({
  value,
  children,
}: {
  value: StorefrontBranding | null;
  children: React.ReactNode;
}) {
  return (
    <StorefrontBrandingContext.Provider value={value}>
      {children}
    </StorefrontBrandingContext.Provider>
  );
}

/**
 * Seller branding (shop name + logo) for the current custom-domain / stall
 * context. Returns null on the main marketplace, so consumers fall back to the
 * default Milk Market presentation.
 */
export function useStorefrontBranding(): StorefrontBranding | null {
  return useContext(StorefrontBrandingContext);
}
