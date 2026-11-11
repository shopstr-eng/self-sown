import type { NextApiRequest, NextApiResponse } from "next";
import { fetchReviewsByAddressesFromDb } from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";

const RATE_LIMIT = { limit: 300, windowMs: 60 * 1000 };

// Cap the address set so a caller can't turn this endpoint into a
// whole-table dump or an unbounded query: a storefront only ever displays a
// bounded product list, and each address is a fixed-shape
// "<kind>:<pubkey>:<d-tag>" string.
const MAX_ADDRESSES = 500;
const MAX_ADDRESS_LENGTH = 512;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "fetch-reviews", RATE_LIMIT))) return;

  try {
    const { addresses } = req.body;

    if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
      return res.status(200).json([]);
    }

    if (
      addresses.length > MAX_ADDRESSES ||
      addresses.some(
        (address) =>
          typeof address !== "string" || address.length > MAX_ADDRESS_LENGTH
      )
    ) {
      return res.status(400).json({ error: "Invalid addresses" });
    }

    const reviews = await fetchReviewsByAddressesFromDb(addresses);
    res.status(200).json(reviews);
  } catch (error) {
    console.error("Failed to fetch reviews from database:", error);
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
}
