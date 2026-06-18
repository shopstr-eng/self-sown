// Resilient client-side storefront resolver.
//
// Every custom-stall page (`/stall/[slug]`, `/stall/[...stallPath]`) and the
// custom-domain placeholder resolve a shop by hitting
// `/api/storefront/lookup`. A single transient blip (network drop, a 500 from a
// DB hiccup, a 429) used to leave the page spinning until a 15s timeout flipped
// it to a misleading "Not Found" — even though the stall was fine. This helper
// distinguishes a DEFINITIVE not-found (HTTP 404) from a TRANSIENT failure and
// retries the latter with jittered backoff so loading hiccups don't break the
// page state.

export type StorefrontLookupResult =
  | { status: "resolved"; pubkey: string; shopSlug: string | null }
  | { status: "not_found" }
  | { status: "transient_error" };

export type StorefrontLookupParam = { slug: string } | { domain: string };

type LookupOptions = {
  signal?: AbortSignal;
  maxAttempts?: number;
  baseDelayMs?: number;
};

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 400;

function buildQuery(param: StorefrontLookupParam): string | null {
  if ("slug" in param && param.slug) {
    return `slug=${encodeURIComponent(param.slug)}`;
  }
  if ("domain" in param && param.domain) {
    return `domain=${encodeURIComponent(param.domain)}`;
  }
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    }
  });
}

/**
 * Resolve a shop pubkey from a slug or custom domain, retrying transient
 * failures. Resolves to:
 *   - `resolved`         — the lookup returned a pubkey.
 *   - `not_found`        — the lookup returned HTTP 404 (definitive). No retry.
 *   - `transient_error`  — network/5xx/429/abort that didn't recover within
 *                          `maxAttempts`. The caller should keep the spinner /
 *                          offer a retry, NOT show a permanent "not found".
 */
export async function lookupStorefront(
  param: StorefrontLookupParam,
  options: LookupOptions = {}
): Promise<StorefrontLookupResult> {
  const query = buildQuery(param);
  if (!query) return { status: "not_found" };

  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const { signal } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) return { status: "transient_error" };

    try {
      const res = await fetch(`/api/storefront/lookup?${query}`, {
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          pubkey?: string;
          shopSlug?: string;
          slug?: string;
        };
        if (data?.pubkey) {
          return {
            status: "resolved",
            pubkey: data.pubkey,
            shopSlug: data.shopSlug ?? data.slug ?? null,
          };
        }
        // 200 with no pubkey is not something the API returns today, but treat
        // it as definitive rather than retrying forever.
        return { status: "not_found" };
      }

      // 404 is definitive: domain/slug not configured, or a lapsed (hidden) Pro
      // seller. No amount of retrying changes it.
      if (res.status === 404) return { status: "not_found" };

      // 5xx / 429 / 408 / anything else — transient, fall through to retry.
    } catch (err) {
      // Aborted by the caller (route changed / unmount) — stop quietly.
      if (err instanceof Error && err.name === "AbortError") {
        return { status: "transient_error" };
      }
      // Network error — transient, fall through to retry.
    }

    // Back off before the next attempt (skip the wait after the final attempt).
    if (attempt < maxAttempts - 1) {
      const delay = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
      await sleep(delay, signal);
    }
  }

  return { status: "transient_error" };
}
