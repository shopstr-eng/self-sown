import type { NextApiRequest, NextApiResponse } from "next";
import { fetchAllProfilesFromDb } from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";

// Returns the full profile set when unfiltered; bigger payload than
// fetch-profile so the per-IP ceiling is somewhat tighter.
const RATE_LIMIT = { limit: 300, windowMs: 60 * 1000 };

// Bound the filter so a crafted URL can't smuggle an oversized IN list;
// storefront/profile callers never need more than a page of sellers and
// chunk their requests below this size.
export const MAX_FILTER_PUBKEYS = 100;

// profile_events has a CHECK constraint limiting kind to these values.
const ALLOWED_KINDS = new Set([0, 30019]);

function parseProfileFilter(
  req: NextApiRequest
): { pubkeys?: string[]; kinds?: number[] } | { error: string } {
  const { pubkeys: pubkeysParam, kinds: kindsParam } = req.query;

  let pubkeys: string[] | undefined;
  if (pubkeysParam !== undefined) {
    if (typeof pubkeysParam !== "string" || pubkeysParam.length === 0) {
      return { error: "Invalid pubkeys parameter" };
    }
    pubkeys = pubkeysParam.split(",");
    if (pubkeys.length > MAX_FILTER_PUBKEYS) {
      return { error: `Too many pubkeys (max ${MAX_FILTER_PUBKEYS})` };
    }
    if (pubkeys.some((pubkey) => !/^[0-9a-f]{64}$/.test(pubkey))) {
      return { error: "Invalid pubkeys parameter" };
    }
  }

  let kinds: number[] | undefined;
  if (kindsParam !== undefined) {
    if (typeof kindsParam !== "string" || kindsParam.length === 0) {
      return { error: "Invalid kinds parameter" };
    }
    const kindValues = kindsParam.split(",");
    // Number("")==0, so reject anything that isn't plain digits first.
    if (kindValues.some((value) => !/^\d+$/.test(value))) {
      return { error: "Invalid kinds parameter" };
    }
    kinds = kindValues.map((value) => Number(value));
    if (kinds.some((kind) => !ALLOWED_KINDS.has(kind))) {
      return { error: "Invalid kinds parameter" };
    }
  }

  return { pubkeys, kinds };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "fetch-profiles", RATE_LIMIT))) return;

  const filter = parseProfileFilter(req);
  if ("error" in filter) {
    return res.status(400).json({ error: filter.error });
  }

  try {
    const profiles = await fetchAllProfilesFromDb(filter);
    res.status(200).json(profiles);
  } catch (error) {
    console.error("Failed to fetch profiles from database:", error);
    res.status(500).json({ error: "Failed to fetch profiles" });
  }
}
