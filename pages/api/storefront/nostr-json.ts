import type { NextApiRequest, NextApiResponse } from "next";
import { fetchCachedEvents, getDbPool } from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";
import { getMembershipView } from "@/utils/pro/membership";

const pool = getDbPool();

// NIP-05 verification is polled by clients on profile loads; keep it generous
// for normal traffic but bounded against a crawler hammering the feed.
const RATE_LIMIT = { limit: 600, windowMs: 60 * 1000 };

/**
 * GET /.well-known/nostr.json (served on seller custom domains via proxy.ts).
 *
 * Returns a NIP-05 name->pubkey mapping for the seller who owns this custom
 * domain, so a seller can advertise a `<username>@<their-domain>` Nostr address
 * that resolves to their own account:
 *
 *   { "names": { "<profile username>": "<raw hex pubkey>" } }
 *
 * SECURITY — resolve, never trust a supplied pubkey. The owning seller is always
 * resolved from the request *domain* against the verified `custom_domains` table
 * and run through the same hidden-membership gate as /api/storefront/lookup, so a
 * lapsed/hidden seller's NIP-05 stops resolving. We deliberately do NOT trust a
 * caller-supplied pubkey header here: this endpoint is publicly reachable, and
 * trusting a forgeable header would let a direct caller bypass the membership
 * gate for any account. The proxy forwards the real custom-domain host via
 * `x-mm-custom-domain-host`; a `?domain=` query is accepted as a fallback for
 * direct/test calls. A forged host only ever returns that domain's already-
 * public NIP-05, so it grants no extra access.
 *
 * The username comes from the seller's kind:0 profile `name` field. NIP-05
 * local-parts are commonly lower-cased by clients before querying, so we expose
 * both the exact username and (when different) its lower-cased form, and honor
 * an optional `?name=` filter case-insensitively. Always returns valid NIP-05
 * JSON (an empty `names` object when nothing resolves) with permissive CORS so
 * browser-based clients can verify cross-origin.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // NIP-05 requires cross-origin reads; allow them on every response.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!applyRateLimit(req, res, "storefront-nostr-json", RATE_LIMIT)) return;

  // Never let an intermediary cache a NIP-05 answer from before a domain was
  // verified or a seller renamed/lapsed (mirrors /api/storefront/lookup).
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const hostHeader = req.headers["x-mm-custom-domain-host"];
    const domainQuery = req.query.domain;
    const domain = (
      (typeof hostHeader === "string" && hostHeader) ||
      (typeof domainQuery === "string" && domainQuery) ||
      ""
    )
      .toLowerCase()
      .trim()
      // Drop any `:port` suffix so a host header like `farm.example:443`
      // still matches the bare domain stored in custom_domains.
      .replace(/:\d+$/, "");

    if (!domain) {
      return res.status(200).json({ names: {} });
    }

    // Resolve the owning seller from the verified custom domain, applying the
    // same hidden-membership gate as the storefront lookup so a lapsed seller's
    // NIP-05 stops resolving.
    const result = await pool.query(
      "SELECT pubkey FROM custom_domains WHERE domain = $1 AND verified = true",
      [domain]
    );
    if (result.rows.length === 0) {
      return res.status(200).json({ names: {} });
    }
    const pubkey = String(result.rows[0].pubkey).toLowerCase();
    const view = await getMembershipView(pubkey);
    if (view.isHidden) {
      return res.status(200).json({ names: {} });
    }

    // Resolve the seller's display username from their cached kind:0 profile.
    let username = "";
    const events = await fetchCachedEvents(0, { pubkey, limit: 1 });
    const event = events[0];
    if (event) {
      try {
        const content = JSON.parse(event.content) as { name?: unknown };
        if (typeof content.name === "string") {
          username = content.name.trim();
        }
      } catch {
        // Malformed profile content — treat as no username (empty names).
      }
    }

    const names: Record<string, string> = {};
    if (username) {
      names[username] = pubkey;
      const lower = username.toLowerCase();
      if (lower !== username) names[lower] = pubkey;
    }

    // Honor an optional NIP-05 `?name=` filter case-insensitively. When the
    // requested local-part matches the seller's username, echo it back under the
    // exact key the client asked for so its `names[name] === pubkey` check
    // passes regardless of casing.
    const nameQuery = req.query.name;
    if (typeof nameQuery === "string" && nameQuery) {
      const match = Object.keys(names).find(
        (k) => k.toLowerCase() === nameQuery.toLowerCase()
      );
      return res
        .status(200)
        .json({ names: match ? { [nameQuery]: names[match] } : {} });
    }

    return res.status(200).json({ names });
  } catch (error) {
    console.error("NIP-05 nostr.json error:", error);
    // Fail soft with valid (empty) NIP-05 JSON rather than a hard error so a
    // transient DB hiccup doesn't surface as a broken well-known file.
    return res.status(200).json({ names: {} });
  }
}
