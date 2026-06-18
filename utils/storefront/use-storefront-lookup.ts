import { useCallback, useEffect, useRef, useState } from "react";
import {
  lookupStorefront,
  type StorefrontLookupParam,
} from "@/utils/storefront/storefront-lookup-client";

export type StorefrontLookupState =
  | { phase: "loading" }
  | { phase: "resolved"; pubkey: string }
  | { phase: "not_found" }
  | { phase: "error" };

type ApiPhase = "pending" | "not_found" | "error";

/** A resolved pubkey tagged with the identity (`kind:value`) it belongs to. */
type ResolvedSeed = { id: string; pubkey: string };

type UseStorefrontLookupArgs = {
  /** "slug" for /stall pages, "domain" for the custom-domain placeholder. */
  kind: "slug" | "domain";
  /** The slug or domain to resolve. Empty string => not_found (once ready). */
  value: string;
  /**
   * Pubkey injected by SSR (getServerSideProps / middleware header). When
   * present the storefront renders immediately with no client lookup. It is
   * tagged with the CURRENT identity so a stale seed can never resolve a
   * mismatched route.
   */
  ssrPubkey?: string | null;
  /**
   * Optional synchronous resolver from already-loaded client data (e.g. the
   * ShopMap context populated from Nostr relays). Lets a stall resolve even
   * when the DB slug row is missing, and prevents a definitive API 404 from
   * masking a shop that exists on relays.
   */
  resolveLocal?: () => string | null;
  /** Whether the local source (ShopMap) is still loading. */
  localPending?: boolean;
  /**
   * Route readiness (`router.isReady`). While false the slug/domain query
   * param can momentarily be empty; we stay in "loading" rather than
   * terminalizing to a misleading not_found.
   */
  ready?: boolean;
};

/**
 * Resilient storefront resolution for stall/custom-domain pages.
 *
 * Resolution precedence: SSR seed → API lookup → local (ShopMap) fallback.
 * Resolved state is bound to the identity (`kind:value`) it was resolved for,
 * so a pubkey from a previous slug/domain is never rendered against the new
 * route — even for the single frame before the reset effect runs.
 *
 * Terminal "not_found" is only reported when the route is ready AND the API
 * definitively 404s AND the local source is exhausted without a match.
 * Transient failures surface as a retryable "error" (never a misleading "not
 * found") and self-heal when the tab regains network/visibility.
 */
export function useStorefrontLookup({
  kind,
  value,
  ssrPubkey,
  resolveLocal,
  localPending,
  ready = true,
}: UseStorefrontLookupArgs): {
  state: StorefrontLookupState;
  retry: () => void;
} {
  const identity = value ? `${kind}:${value}` : "";

  const [resolved, setResolved] = useState<ResolvedSeed | null>(
    ssrPubkey && identity ? { id: identity, pubkey: ssrPubkey } : null
  );
  const [apiPhase, setApiPhase] = useState<ApiPhase>("pending");

  const reqIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // A resolved pubkey only counts for the ACTIVE identity. This guarantees a
  // lingering pubkey from a previous slug/domain is never shown against the new
  // route, addressing the "old data from a previous domain" symptom.
  const pubkey = resolved && resolved.id === identity ? resolved.pubkey : "";

  const runLookup = useCallback(() => {
    if (!identity) {
      setApiPhase("not_found");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const id = ++reqIdRef.current;
    const lookupIdentity = identity;
    setApiPhase("pending");

    const param: StorefrontLookupParam =
      kind === "slug" ? { slug: value } : { domain: value };

    lookupStorefront(param, { signal: controller.signal })
      .then((result) => {
        if (reqIdRef.current !== id) return;
        if (result.status === "resolved") {
          setResolved({ id: lookupIdentity, pubkey: result.pubkey });
        } else if (result.status === "not_found") {
          setApiPhase("not_found");
        } else {
          setApiPhase("error");
        }
      })
      .catch(() => {
        if (reqIdRef.current !== id) return;
        setApiPhase("error");
      });
  }, [kind, value, identity]);

  // Reset + (re)start whenever the identity or readiness changes. Re-seeding
  // from SSR is tagged with the current identity, so a stale prop can't resolve
  // a mismatched route.
  useEffect(() => {
    setResolved(
      ssrPubkey && identity ? { id: identity, pubkey: ssrPubkey } : null
    );
    setApiPhase("pending");
    if (!ready) return; // wait for router.isReady — query may be empty.
    if (ssrPubkey && identity) return; // SSR fast path — already resolved.
    runLookup();
    return () => {
      // Invalidate any in-flight lookup so a late settle can't write state
      // after unmount / identity change.
      reqIdRef.current++;
      abortRef.current?.abort();
    };
  }, [identity, ssrPubkey, ready, runLookup]);

  // Local (ShopMap) fallback. Runs whenever local data changes and we haven't
  // resolved yet — covers shops present on relays but missing a DB slug row,
  // and recovers from a definitive API 404.
  useEffect(() => {
    if (pubkey) return;
    if (!ready || !identity) return;
    if (!resolveLocal) return;
    const found = resolveLocal();
    if (found) setResolved({ id: identity, pubkey: found });
  }, [pubkey, ready, identity, resolveLocal, localPending]);

  // Self-heal: when stuck in a transient error, retry on regained
  // connectivity / tab focus instead of stranding the visitor.
  useEffect(() => {
    if (pubkey) return;
    if (apiPhase !== "error") return;

    const onWake = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      runLookup();
    };
    window.addEventListener("online", onWake);
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("online", onWake);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [pubkey, apiPhase, runLookup]);

  const retry = useCallback(() => {
    if (pubkey) return;
    runLookup();
  }, [pubkey, runLookup]);

  // Synchronous local (ShopMap) fallback for the render decision. The effect
  // above persists this match for guard stability, but computing it inline too
  // means a definitive API 404 (or transient error) can never flash a
  // not_found/error frame for a shop that exists in already-loaded relay data
  // but lacks a DB slug row — preserving the pre-refactor behavior where local
  // resolution always won over a missing DB lookup.
  const localPubkey =
    !pubkey && ready && !!identity && !localPending && resolveLocal
      ? resolveLocal() || ""
      : "";
  const effectivePubkey = pubkey || localPubkey;

  let state: StorefrontLookupState;
  if (effectivePubkey) {
    state = { phase: "resolved", pubkey: effectivePubkey };
  } else if (!ready || apiPhase === "pending" || localPending) {
    state = { phase: "loading" };
  } else if (apiPhase === "not_found") {
    state = { phase: "not_found" };
  } else {
    state = { phase: "error" };
  }

  return { state, retry };
}
