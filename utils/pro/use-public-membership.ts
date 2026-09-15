// Client hook for reading ANOTHER seller's public membership status (e.g. when
// rendering a storefront you don't own). Use this to suppress a hidden seller's
// custom design/domain on the public site. For the logged-in seller's OWN
// membership use `useProMembership()` instead.
//
// Backed by the public `/api/pro/status` endpoint. Results are cached at module
// scope (and in-flight requests deduped) so many components on the same
// storefront page share a single fetch.
//
// Transient-failure policy: a definitive 200 response always applies
// immediately (fail closed on isPro:false / hidden), but a network error or
// non-OK status is retried with backoff, and a terminal failure falls back to
// a last-known-good view cached per pubkey (TTL-bounded) instead of stripping
// a paying seller's branding mid-outage.

import { useEffect, useState } from "react";
import type { MembershipView } from "@/utils/pro/constants";
import { freeMembershipView } from "@/utils/pro/membership-status";

interface PublicMembership {
  view: MembershipView | null;
  isHidden: boolean;
  isReadOnly: boolean;
  isPro: boolean;
  loading: boolean;
}

// Cache entries carry a fetch timestamp and expire after TTL. Without this a
// seller cached as Pro would keep being treated as Pro for the whole session
// even after they lapse — re-serving premium chrome the entitlement no longer
// covers. A short TTL bounds that staleness window while still deduping the
// many storefront components that read the same seller on one page load.
const CACHE_TTL_MS = 60_000;

// How long a last-known-good membership view stays usable while the status
// endpoint is unreachable. Bounds how long an outage can extend a lapsed
// seller's styling; every definitive 200 overwrites it.
export const PRO_STATUS_LKG_TTL_MS = 24 * 60 * 60 * 1000;

// Total fetch attempts before giving up (1 initial + retries), and the delay
// before each retry. Bounded so a persistent outage resolves to a final
// answer (last-known-good or fail-closed) in ~2.5s.
export const PRO_STATUS_MAX_ATTEMPTS = 3;
export const PRO_STATUS_RETRY_BACKOFF_MS = [500, 2000];

const LKG_KEY_PREFIX = "sf_pro_status:";

const cache = new Map<string, { view: MembershipView; at: number }>();
const inflight = new Map<string, Promise<MembershipView>>();

function getFresh(pubkey: string): MembershipView | null {
  const entry = cache.get(pubkey);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(pubkey);
    return null;
  }
  return entry.view;
}

/** Last-known-good membership view for a pubkey, or null when absent/stale. */
export function readLastKnownGoodMembership(
  pubkey: string
): MembershipView | null {
  try {
    const raw = localStorage.getItem(LKG_KEY_PREFIX + pubkey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      view: MembershipView;
      checkedAt: number;
    };
    if (
      !parsed?.view ||
      typeof parsed.checkedAt !== "number" ||
      typeof parsed.view.isPro !== "boolean" ||
      parsed.view.pubkey !== pubkey
    ) {
      return null;
    }
    if (Date.now() - parsed.checkedAt > PRO_STATUS_LKG_TTL_MS) return null;
    return parsed.view;
  } catch {
    return null;
  }
}

function writeLastKnownGoodMembership(
  pubkey: string,
  view: MembershipView
): void {
  try {
    localStorage.setItem(
      LKG_KEY_PREFIX + pubkey,
      JSON.stringify({ view, checkedAt: Date.now() })
    );
  } catch {
    // Storage full/blocked — the live fetch result still applies this session.
  }
}

/** Test-only: reset the module-scope caches between tests. */
export function resetPublicMembershipCache(): void {
  cache.clear();
  inflight.clear();
}

async function fetchStatus(pubkey: string): Promise<MembershipView> {
  const fresh = getFresh(pubkey);
  if (fresh) return fresh;
  const existing = inflight.get(pubkey);
  if (existing) return existing;

  const p = (async () => {
    try {
      for (let attempt = 0; attempt < PRO_STATUS_MAX_ATTEMPTS; attempt++) {
        try {
          const res = await fetch(
            `/api/pro/status?pubkey=${encodeURIComponent(pubkey)}`
          );
          if (res.ok) {
            // Definitive answer: apply it (fail closed on isPro:false) and
            // record it as the new last-known-good.
            const data = (await res.json()) as MembershipView;
            cache.set(pubkey, { view: data, at: Date.now() });
            writeLastKnownGoodMembership(pubkey, data);
            return data;
          }
          // Non-OK (5xx/429/...): transient — retry below.
        } catch {
          // Network error: transient — retry below.
        }
        if (attempt < PRO_STATUS_MAX_ATTEMPTS - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, PRO_STATUS_RETRY_BACKOFF_MS[attempt])
          );
        }
      }
      // Terminal transient failure: keep the last-known-good view if we have
      // a fresh one; only then fail closed to the free view.
      return readLastKnownGoodMembership(pubkey) ?? freeMembershipView(pubkey);
    } finally {
      inflight.delete(pubkey);
    }
  })();
  inflight.set(pubkey, p);
  return p;
}

export function usePublicMembershipStatus(
  pubkey: string | null | undefined
): PublicMembership {
  // State is keyed by the pubkey it was resolved FOR. All outputs are derived
  // through the `resolved.pubkey === pubkey` gate, so a client-side switch to
  // a different seller can never inherit the previous seller's view — even
  // for the renders before the effect below re-resolves.
  const [resolved, setResolved] = useState<{
    pubkey: string;
    view: MembershipView;
  } | null>(() => {
    if (!pubkey) return null;
    const fresh = getFresh(pubkey);
    return fresh ? { pubkey, view: fresh } : null;
  });
  const view = resolved && resolved.pubkey === pubkey ? resolved.view : null;
  const loading = !!pubkey && view === null;

  useEffect(() => {
    let active = true;
    if (!pubkey) {
      setResolved(null);
      return;
    }
    const cached = getFresh(pubkey);
    if (cached) {
      setResolved({ pubkey, view: cached });
      return;
    }
    // Seed from last-known-good so a transient status outage never strips a
    // paying seller's branding, then refresh in the background — a definitive
    // response (incl. a lapse) still replaces it as soon as the endpoint is
    // reachable.
    const lkg = readLastKnownGoodMembership(pubkey);
    if (lkg) {
      setResolved({ pubkey, view: lkg });
    }
    fetchStatus(pubkey).then((v) => {
      if (active) {
        setResolved({ pubkey, view: v });
      }
    });
    return () => {
      active = false;
    };
  }, [pubkey]);

  return {
    view,
    isHidden: !!view?.isHidden,
    isReadOnly: !!view?.isReadOnly,
    isPro: !!view?.isPro,
    loading,
  };
}
