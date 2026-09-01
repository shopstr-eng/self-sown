import type { NextApiRequest, NextApiResponse } from "next";
import sharp from "sharp";
import { applyRateLimit } from "@/utils/rate-limit";
import { parseHttpUrl, safeFetch, SafeFetchError } from "@/utils/url-safety";

// Public image-optimization proxy for og:image/twitter:image tags. Seller
// OG/banner/product images are uploaded to arbitrary third-party hosts and are
// often multi-MB; this route serves a compressed, right-sized copy so social
// cards render quickly and sharply. Crawlers hit it directly, so it must be
// abuse-safe on its own: SSRF-guarded fetch, per-IP rate limit, streamed body
// cap, and an in-memory cache.

const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };
const MAX_SOURCE_BYTES = 10 * 1024 * 1024; // 10 MB source cap
const BODY_READ_DEADLINE_MS = 15_000;
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
// Fixed base for resolving same-origin relative paths (e.g. "/milk-market.png").
// Never the request Host header — that would be a spoofable SSRF oracle.
const PLATFORM_BASE = process.env.NEXT_PUBLIC_BASE_URL || "https://milk.market";

type CacheEntry = { buf: Buffer; contentType: string; ts: number };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

class BodyTooLargeError extends Error {}

// Mutable so tests can shrink the deadline without waiting 15s per case.
let bodyReadDeadlineMs = BODY_READ_DEADLINE_MS;
export function __setBodyReadDeadlineForTests(ms: number | null) {
  bodyReadDeadlineMs = ms ?? BODY_READ_DEADLINE_MS;
}

async function readBodyWithCap(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_SOURCE_BYTES) throw new BodyTooLargeError();

  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("Response body is not readable");

  const chunks: Buffer[] = [];
  let total = 0;
  const deadline = Date.now() + bodyReadDeadlineMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Image body read deadline exceeded");
    }
    // Race each read against the remaining deadline: a stalled/trickling
    // upstream must not be able to hold the request worker indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Image body read timed out")),
            remaining
          );
        }),
      ]);
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const { done, value } = result;
    if (done) break;
    if (value && value.byteLength > 0) {
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

async function fetchAndTransform(
  sourceUrl: string,
  format: "jpeg" | "webp"
): Promise<CacheEntry> {
  const response = await safeFetch(sourceUrl, {
    accept: "image/*",
    // Never let the image endpoint become a redirect oracle. A crawler can
    // follow a legitimate image redirect itself, but the server must not.
    followRedirects: false,
    timeoutMs: 8000,
  });
  if (!response.ok) {
    throw new Error(`Upstream image fetch failed: ${response.status}`);
  }
  const contentType = (response.headers.get("content-type") || "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (!/^image\/(?:avif|gif|jpe?g|png|tiff|webp)$/i.test(contentType)) {
    throw new Error(
      `Upstream URL is not an image: ${contentType || "unknown"}`
    );
  }

  const source = await readBodyWithCap(response);

  let pipeline = sharp(source, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize({
      width: OG_WIDTH,
      height: OG_HEIGHT,
      fit: "inside",
      withoutEnlargement: true,
    });
  if (format === "webp") {
    pipeline = pipeline.webp({ quality: 82 });
  } else {
    const meta = await sharp(source, {
      limitInputPixels: 50_000_000,
    }).metadata();
    if (meta.hasAlpha) pipeline = pipeline.flatten({ background: "#ffffff" });
    pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true });
  }
  const buf = await pipeline.toBuffer();

  return {
    buf,
    contentType: format === "webp" ? "image/webp" : "image/jpeg",
    ts: Date.now(),
  };
}

function evictCacheIfNeeded() {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  // Map iterates in insertion order — drop the oldest entries first.
  const excess = cache.size - CACHE_MAX_ENTRIES;
  let dropped = 0;
  for (const key of cache.keys()) {
    if (dropped >= excess) break;
    cache.delete(key);
    dropped++;
  }
}

function sendEntry(res: NextApiResponse, entry: CacheEntry) {
  res.setHeader("Content-Type", entry.contentType);
  res.setHeader("Content-Length", entry.buf.length);
  res.setHeader(
    "Cache-Control",
    "public, max-age=86400, stale-while-revalidate=604800"
  );
  return res.status(200).send(entry.buf);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "og-image", RATE_LIMIT))) return;

  const { url, fmt } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing url" });
  }

  let sourceUrl: string;
  if (url.startsWith("/")) {
    const platform = parseHttpUrl(PLATFORM_BASE);
    let relative: URL;
    try {
      relative = new URL(url, platform?.toString());
    } catch {
      return res.status(400).json({ error: "Invalid url" });
    }
    // `//host/path` and backslash variants are network-path references, not
    // platform-relative paths. Do not turn them into an arbitrary proxy.
    if (
      !platform ||
      relative.origin !== platform.origin ||
      relative.pathname.startsWith("/api/")
    ) {
      return res.status(400).json({ error: "Invalid url" });
    }
    sourceUrl = relative.toString();
  } else {
    const parsed = parseHttpUrl(url);
    if (!parsed) {
      return res.status(400).json({ error: "Invalid url" });
    }
    const platform = parseHttpUrl(PLATFORM_BASE);
    if (
      platform &&
      parsed.origin === platform.origin &&
      parsed.pathname.startsWith("/api/")
    ) {
      return res.status(400).json({ error: "Invalid url" });
    }
    sourceUrl = parsed.toString();
  }
  const format = fmt === "webp" ? "webp" : "jpeg";
  const cacheKey = `${format}|${sourceUrl}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return sendEntry(res, cached);
  }

  try {
    let pending = inflight.get(cacheKey);
    if (!pending) {
      pending = fetchAndTransform(sourceUrl, format);
      inflight.set(cacheKey, pending);
    }
    const entry = await pending;
    cache.set(cacheKey, entry);
    evictCacheIfNeeded();
    return sendEntry(res, entry);
  } catch (err) {
    if (err instanceof SafeFetchError) {
      return res.status(400).json({ error: "URL host is not allowed" });
    }
    // Do not disclose or redirect to a caller-controlled upstream URL. Apart
    // from privacy leakage, that would let this endpoint bypass its own
    // redirect and content checks.
    if (err instanceof BodyTooLargeError) {
      return res.status(413).json({ error: "Image too large" });
    }
    return res.status(502).json({ error: "Unable to fetch image" });
  } finally {
    inflight.delete(cacheKey);
  }
}
