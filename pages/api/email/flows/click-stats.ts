/**
 * Read-only click/engagement stats for the authenticated seller's own email
 * flows (aggregate click counts + last-click dates, no recipient detail).
 *
 * Email engagement analytics is a paid Herd feature and exposes business
 * performance data, so this requires NIP-98 auth + an active membership and
 * serves only the authenticated pubkey's own data — there is no way to read
 * another seller's click stats.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { getFlowClickStats } from "@/utils/db/db-service";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { applyRateLimit } from "@/utils/rate-limit";

const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "email-flow-click-stats", RATE_LIMIT)))
    return;

  const authResult = await verifyNip98Request(req, req.method);
  if (!authResult.ok) {
    return res.status(401).json({ error: authResult.error });
  }

  // Engagement analytics is a paid Herd feature. Gate on entitlement so
  // lapsed sellers (and free sellers who somehow have flows) can't read click
  // performance data even with a valid signature.
  if (!(await requireProEntitlement(authResult.pubkey, res))) return;

  try {
    const rows = await getFlowClickStats(authResult.pubkey);
    const stats: Record<
      number,
      {
        total: number;
        lastClicked: string | null;
        steps: Record<number, number>;
      }
    > = {};
    for (const row of rows) {
      const entry = (stats[row.flow_id] ||= {
        total: 0,
        lastClicked: null,
        steps: {},
      });
      entry.total += row.clicks;
      if (row.step_id != null) entry.steps[row.step_id] = row.clicks;
      const lc = row.last_clicked
        ? new Date(row.last_clicked).toISOString()
        : null;
      if (lc && (!entry.lastClicked || lc > entry.lastClicked)) {
        entry.lastClicked = lc;
      }
    }
    return res.status(200).json({ stats });
  } catch (error) {
    console.error("Error fetching flow click stats:", error);
    return res.status(500).json({ error: "Failed to fetch click stats" });
  }
}
