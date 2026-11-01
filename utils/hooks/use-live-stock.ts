import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  applyStockToProduct,
  type InventorySnapshot,
} from "@/utils/inventory/live-stock";

/**
 * Local stock for product cards and listing pages.
 *
 * Every card asks for its own product, but the requests are collected for a
 * moment and sent as one `GET /api/inventory?productIds=...`, so a grid of
 * cards costs a single call. Answers are cached for a short time. Any failure
 * leaves a card on the listing's own quantities.
 */

const CACHE_TTL_MS = 30_000;
// A request that never answers must not block the product forever.
const PENDING_TIMEOUT_MS = 15_000;
const FLUSH_DELAY_MS = 25;
// Matches the server-side cap on one batch read.
const MAX_IDS_PER_REQUEST = 100;

interface CacheEntry {
  snapshot: InventorySnapshot | null;
  fetchedAt: number;
  /** When the in-flight request started, or null when none is in flight. */
  pendingSince: number | null;
}

const cache = new Map<string, CacheEntry>();
const listeners = new Set<() => void>();
let queue = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function fetchChunk(ids: string[]) {
  const settle = (stock: Record<string, InventorySnapshot> | null) => {
    const fetchedAt = Date.now();
    for (const id of ids) {
      const previous = cache.get(id)?.snapshot ?? null;
      // On failure keep what we already knew and retry after the TTL.
      cache.set(id, {
        snapshot: stock ? (stock[id] ?? null) : previous,
        fetchedAt,
        pendingSince: null,
      });
    }
    notify();
  };

  try {
    const response = await fetch(
      `/api/inventory?productIds=${encodeURIComponent(ids.join(","))}`
    );
    if (!response.ok) return settle(null);
    const body = await response.json();
    settle(body && typeof body.stock === "object" ? body.stock : null);
  } catch {
    settle(null);
  }
}

function flush() {
  flushTimer = null;
  const ids = [...queue];
  queue = new Set();
  for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
    void fetchChunk(ids.slice(i, i + MAX_IDS_PER_REQUEST));
  }
}

function request(productId: string) {
  const entry = cache.get(productId);
  const now = Date.now();
  if (entry) {
    const inFlight =
      entry.pendingSince !== null &&
      now - entry.pendingSince < PENDING_TIMEOUT_MS;
    if (inFlight || now - entry.fetchedAt < CACHE_TTL_MS) return;
  }
  cache.set(productId, {
    snapshot: entry?.snapshot ?? null,
    fetchedAt: entry?.fetchedAt ?? 0,
    pendingSince: now,
  });
  queue.add(productId);
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

/** Local stock snapshot for one product, or null until known / when untracked. */
export function useLiveStock(productId?: string): InventorySnapshot | null {
  const getSnapshot = useCallback(
    () => (productId ? (cache.get(productId)?.snapshot ?? null) : null),
    [productId]
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => null);

  useEffect(() => {
    if (productId) request(productId);
  }, [productId]);

  return snapshot;
}

/**
 * The product with its quantities replaced by newer local stock (newer-wins
 * rule). Returns the same object while nothing changes.
 */
export function useProductWithLiveStock<
  T extends {
    id: string;
    createdAt: number;
    quantity?: number;
    sizes?: string[];
    sizeQuantities?: Map<string, number>;
  },
>(product: T | undefined | null): T | undefined | null {
  const snapshot = useLiveStock(product?.id);
  return useMemo(
    () => (product ? applyStockToProduct(product, snapshot) : product),
    [product, snapshot]
  );
}

/** Test helper: forget everything so cases don't leak into each other. */
export function resetLiveStockCacheForTests() {
  cache.clear();
  queue = new Set();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}
