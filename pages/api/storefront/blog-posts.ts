import type { NextApiRequest, NextApiResponse } from "next";
import { fetchBlogPostsByPubkeyFromDb } from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";

export const config = {
  api: {
    responseLimit: false,
  },
};

// Public read of a seller's blog posts (kind:30023), deduped to the latest
// version per d-tag. Loaded by storefront blog sections + the themed blog
// index/post pages, including on seller custom domains (this path sits under
// the /api/storefront/ custom-domain allowlist in proxy.ts).
const RATE_LIMIT = { limit: 300, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "blog-posts", RATE_LIMIT))) return;

  try {
    const { pubkey } = req.query;
    if (!pubkey || typeof pubkey !== "string") {
      return res.status(400).json({ error: "pubkey is required" });
    }
    const posts = await fetchBlogPostsByPubkeyFromDb(pubkey);
    res.status(200).json(posts);
  } catch (error) {
    console.error("Failed to fetch blog posts from database:", error);
    res.status(500).json({ error: "Failed to fetch blog posts" });
  }
}
