/**
 * Client-side base-URL resolution + sharing for seller share links.
 *
 * The standing rule: when a seller has a VERIFIED custom domain, any link we
 * generate for sharing their storefront must use that domain, never the
 * platform /stall/<slug> URL. Server code uses resolveSellerStorefrontUrl in
 * utils/db/custom-domains.ts; client components can't query the DB, so they
 * read the public read-only custom-domain endpoint through this module.
 *
 * navigator.share must be invoked synchronously inside the click's transient
 * user activation — awaiting this lookup in the click handler makes the share
 * sheet fail with NotAllowedError. Callers therefore PREFETCH on mount (or
 * whenever the seller pubkey becomes known) and read the result synchronously
 * via getCachedSellerCustomDomainBaseUrl in the handler. On a cold cache the
 * handler falls back to the platform URL and the in-flight prefetch serves
 * the next click.
 */
import { copyToClipboard } from "@/utils/clipboard";

// Bounded so a hung endpoint can't wedge the cache in "in flight" forever.
const FETCH_TIMEOUT_MS = 2500;
// Negative results (no domain, transient failure) expire so a newly verified
// domain or a recovered network is picked up without a page reload.
const NEGATIVE_TTL_MS = 60_000;

type CacheEntry = {
  settled: boolean;
  value: string | null;
  settledAt: number;
};

const cache = new Map<string, CacheEntry>();

async function fetchCustomDomainBaseUrl(pubkey: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(
        `/api/storefront/custom-domain?pubkey=${encodeURIComponent(pubkey)}`,
        { signal: controller.signal }
      );
      if (!res.ok) return null;
      const row = await res.json();
      if (row && row.verified && typeof row.domain === "string") {
        return `https://${row.domain}`;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

function ensureEntry(pubkey: string): CacheEntry {
  const existing = cache.get(pubkey);
  if (existing) return existing;
  const entry: CacheEntry = { settled: false, value: null, settledAt: 0 };
  cache.set(pubkey, entry);
  void fetchCustomDomainBaseUrl(pubkey).then((value) => {
    entry.settled = true;
    entry.value = value;
    entry.settledAt = Date.now();
  });
  return entry;
}

/**
 * Start resolving the seller's custom domain in the background. Call this as
 * soon as the seller pubkey is known (e.g. component mount) so the share
 * click never has to wait on the network.
 */
export function prefetchSellerCustomDomainBaseUrl(pubkey: string): void {
  ensureEntry(pubkey);
}

/**
 * Synchronous read of the prefetched result: the seller's verified custom
 * domain as an https origin (e.g. "https://shop.example.com"), or null when
 * they have none or the lookup hasn't settled yet. On a custom domain the
 * stall is root-mapped, so callers should append paths WITHOUT the
 * /stall/<slug> prefix (e.g. `${base}/listing/${id}`).
 */
export function getCachedSellerCustomDomainBaseUrl(
  pubkey: string
): string | null {
  const entry = ensureEntry(pubkey);
  if (!entry.settled) return null;
  if (entry.value === null && Date.now() - entry.settledAt > NEGATIVE_TTL_MS) {
    // Expired negative result: re-resolve in the background for next time.
    cache.delete(pubkey);
    ensureEntry(pubkey);
    return null;
  }
  return entry.value;
}

/**
 * Invoke the native share sheet synchronously (transient user activation) and
 * recover visibly when it genuinely fails — e.g. activation lost or the sheet
 * unavailable — by copying the link and notifying via onCopied. A user
 * dismissing the sheet (AbortError) is not a failure and stays silent.
 */
export function shareProductUrl(args: {
  title: string;
  shareUrl: string;
  onCopied: () => void;
}): void {
  const { title, shareUrl, onCopied } = args;
  const copyFallback = () => {
    void copyToClipboard(shareUrl)
      .then(onCopied)
      .catch(() => {});
  };
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    navigator.share({ title, url: shareUrl }).catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      copyFallback();
    });
  } else {
    copyFallback();
  }
}

/** Test-only: clear the per-pubkey cache between tests. */
export function __resetSellerShareUrlCacheForTests(): void {
  cache.clear();
}
