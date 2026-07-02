import type { NextApiRequest, NextApiResponse } from "next";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";
import { checkRateLimit, getRequestIp } from "@/utils/rate-limit";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { parseHttpUrl } from "@/utils/url-safety";
import {
  extractSiteSignals,
  hasUsableSignals,
  SiteExtractionError,
} from "@/utils/migrations/site-design-extractor";
import { buildExtractionDraft } from "@/utils/migrations/site-design";
import { composeStoreDesignWithAI } from "@/utils/storefront/ai-compose";

// Each call fetches an arbitrary external site + a few stylesheets and may hit
// the LLM, so keep the per-caller cap tight.
const RATE_LIMIT = { limit: 5, windowMs: 60 * 1000 };
const AUTH_PATH = "/api/storefront/import-from-url";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rate = await checkRateLimit(
    "storefront-import",
    getRequestIp(req),
    RATE_LIMIT
  );
  res.setHeader("X-RateLimit-Limit", String(rate.limit));
  res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(rate.resetAt / 1000)));
  if (!rate.ok) {
    res.setHeader(
      "Retry-After",
      String(Math.max(0, Math.ceil((rate.resetAt - Date.now()) / 1000)))
    );
    return res.status(429).json({ error: "Too many requests" });
  }

  const { pubkey, url, signedEvent } = req.body ?? {};
  if (!pubkey || !url) {
    return res.status(400).json({ error: "pubkey and url are required" });
  }
  if (!signedEvent) {
    return res.status(400).json({ error: "signedEvent is required" });
  }

  const parsed = parseHttpUrl(String(url).trim());
  if (!parsed) {
    return res
      .status(400)
      .json({ error: "Enter a valid http(s) website address" });
  }
  const cleanUrl = parsed.toString();

  const authResult = verifyNostrAuth(
    signedEvent,
    pubkey,
    "storefront-import-write",
    {
      method: "POST",
      path: AUTH_PATH,
      fields: { url: cleanUrl },
    }
  );
  if (!authResult.valid) {
    return res
      .status(401)
      .json({ error: authResult.error || "Authentication failed" });
  }

  if (!(await requireProEntitlement(pubkey, res))) return;

  let signals;
  try {
    signals = await extractSiteSignals(cleanUrl);
  } catch (err) {
    if (err instanceof SiteExtractionError) {
      return res.status(422).json({ error: err.message });
    }
    console.error("Storefront import extraction failed:", err);
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
      return res.status(200).json({ design: enhanced });
    }
    draft.warnings.push(
      "AI styling is unavailable right now — we built a design straight from your site."
    );
  } catch (err) {
    console.error("Storefront import AI composition failed:", err);
    draft.warnings.push(
      "AI styling failed — we built a design straight from your site."
    );
  }

  return res.status(200).json({ design: draft });
}
