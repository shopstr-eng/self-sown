import type { NextApiRequest, NextApiResponse } from "next";
import { nip19 } from "nostr-tools";
import { applyRateLimit } from "@/utils/rate-limit";
import { requireAdmin } from "@/utils/admin/auth";
import { getMembershipView } from "@/utils/pro/membership";

const RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

/**
 * Normalize a seller identifier (npub or 64-char hex) to lowercase hex.
 * Returns null when the input isn't a valid pubkey.
 */
export function normalizePubkey(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("npub")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "npub" && typeof decoded.data === "string") {
        return decoded.data.toLowerCase();
      }
    } catch {
      return null;
    }
    return null;
  }
  const hex = trimmed.toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!(await applyRateLimit(req, res, "admin-membership-lookup", RATE_LIMIT)))
    return;
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const pubkey = normalizePubkey(req.body?.pubkey);
  if (!pubkey) {
    return res
      .status(400)
      .json({ error: "A valid seller npub or hex pubkey is required" });
  }

  const admin = requireAdmin(req, res, "admin-membership-lookup", {
    method: "POST",
    path: "/api/admin/memberships",
    fields: { pubkey },
  });
  if (!admin) return; // requireAdmin already wrote the response

  try {
    const view = await getMembershipView(pubkey);
    return res.status(200).json({ view });
  } catch (error) {
    console.error("Admin membership lookup error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
