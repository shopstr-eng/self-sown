import { usePublicMembershipStatus } from "@/utils/pro/use-public-membership";

/**
 * Resolves the viewed seller's Pro entitlement for storefront theming.
 *
 * Returns true/false once resolved, null while unresolved. Fail-closed is
 * preserved for genuinely non-Pro sellers (a definitive 200 + isPro:false
 * strips premium styling immediately), but transient failures (network error,
 * 5xx) retry with backoff and fall back to a last-known-good entitlement
 * cached per seller pubkey, so a status-check hiccup never strips a paying
 * seller's design mid-visit. The shared resolver in
 * utils/pro/use-public-membership.ts owns the retry/cache semantics and is
 * pubkey-scoped, so a stale `true` from a previously-viewed seller can never
 * apply to a different seller during a client-side shop switch.
 */
export function useStorefrontProEntitlement(
  shopPubkey: string
): boolean | null {
  const { isPro, loading } = usePublicMembershipStatus(shopPubkey || null);
  if (!shopPubkey) return null;
  return loading ? null : isPro;
}
