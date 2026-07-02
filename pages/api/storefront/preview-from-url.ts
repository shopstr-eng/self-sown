import type { NextApiRequest, NextApiResponse } from "next";
import { checkRateLimit, getRequestIp } from "@/utils/rate-limit";
import { parseHttpUrl } from "@/utils/url-safety";
import {
  extractSiteSignals,
  hasUsableSignals,
  SiteExtractionError,
} from "@/utils/migrations/site-design-extractor";
import {
  buildExtractionDraft,
  type ImportedStoreDesign,
} from "@/utils/migrations/site-design";
import { composeStoreDesignWithAI } from "@/utils/storefront/ai-compose";

// PUBLIC, UNGATED endpoint powering the /stall-preview outreach tool. Anyone can drop
// a URL and get a preview stall design — no account, no Pro. This is the same
// pipeline as /api/storefront/import-from-url but WITHOUT the Nostr-auth + Pro
// gate, so it is an unauthenticated server-side URL fetcher that can also hit
// the LLM. It is guarded three ways:
//   1. a tight per-IP limit,
//   2. a GLOBAL bucket so distributed abuse can't run unbounded model spend,
//   3. a short-TTL per-URL cache (also makes an outreach link show the SAME
//      design every time a prospect opens it, and avoids re-billing the LLM).
// SSRF is handled inside extractSiteSignals -> safeFetch (private IPs rejected).

const PER_IP_LIMIT = { limit: 3, windowMs: 60 * 1000 };
const GLOBAL_LIMIT = { limit: 40, windowMs: 60 * 1000 };
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

type CacheEntry = { design: ImportedStoreDesign; expiresAt: number };
const previewCache = new Map<string, CacheEntry>();

function getCached(url: string): ImportedStoreDesign | null {
  const hit = previewCache.get(url);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    previewCache.delete(url);
    return null;
  }
  return hit.design;
}

function setCached(url: string, design: ImportedStoreDesign): void {
  if (previewCache.size >= CACHE_MAX) {
    const oldest = previewCache.keys().next().value;
    if (oldest) previewCache.delete(oldest);
  }
  previewCache.set(url, { design, expiresAt: Date.now() + CACHE_TTL_MS });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const perIp = await checkRateLimit(
    "storefront-preview",
    getRequestIp(req),
    PER_IP_LIMIT
  );
  res.setHeader("X-RateLimit-Limit", String(perIp.limit));
  res.setHeader("X-RateLimit-Remaining", String(perIp.remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(perIp.resetAt / 1000)));
  if (!perIp.ok) {
    res.setHeader(
      "Retry-After",
      String(Math.max(0, Math.ceil((perIp.resetAt - Date.now()) / 1000)))
    );
    return res.status(429).json({ error: "Too many requests" });
  }

  const { url } = req.body ?? {};
  if (!url) {
    return res.status(400).json({ error: "url is required" });
  }

  const parsed = parseHttpUrl(String(url).trim());
  if (!parsed) {
    return res
      .status(400)
      .json({ error: "Enter a valid http(s) website address" });
  }
  const cleanUrl = parsed.toString();

  // Serve a recent preview for this exact URL without re-fetching or re-billing
  // the LLM. This is the common case for a shared outreach link.
  const cached = getCached(cleanUrl);
  if (cached) {
    return res.status(200).json({ design: cached });
  }

  // Only spend the global budget on a real cache miss (extraction + LLM work).
  const global = await checkRateLimit(
    "storefront-preview-global",
    "global",
    GLOBAL_LIMIT
  );
  if (!global.ok) {
    res.setHeader(
      "Retry-After",
      String(Math.max(0, Math.ceil((global.resetAt - Date.now()) / 1000)))
    );
    return res.status(429).json({
      error:
        "Our preview tool is busy right now. Please try again in a minute.",
    });
  }

  let signals;
  try {
    signals = await extractSiteSignals(cleanUrl);
  } catch (err) {
    if (err instanceof SiteExtractionError) {
      return res.status(422).json({ error: err.message });
    }
    console.error("Storefront preview extraction failed:", err);
    return res
      .status(502)
      .json({ error: "Could not read that website. Please try another URL." });
  }

  if (!hasUsableSignals(signals)) {
    return res.status(422).json({
      error:
        "We couldn't find any design details on that page. Try your homepage URL.",
    });
  }

  const draft = buildExtractionDraft(signals);

  // AI enhancement is best-effort. If the integration isn't configured or the
  // model errors/returns junk, we ship the deterministic draft.
  try {
    const enhanced = await composeStoreDesignWithAI(signals, draft);
    if (enhanced) {
      setCached(cleanUrl, enhanced);
      return res.status(200).json({ design: enhanced });
    }
    draft.warnings.push(
      "AI styling is unavailable right now — we built a design straight from your site."
    );
  } catch (err) {
    console.error("Storefront preview AI composition failed:", err);
    draft.warnings.push(
      "AI styling failed — we built a design straight from your site."
    );
  }

  setCached(cleanUrl, draft);
  return res.status(200).json({ design: draft });
}
