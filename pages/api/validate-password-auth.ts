import { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";

const RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "validate-password-auth", RATE_LIMIT)))
    return;

  const passwordStorageKey = process.env["PASSWORD_STORAGE_KEY"];
  // The listing password is intentionally a human/manual-action check, not a
  // secret, so we surface the value for the prompt to display to the seller.
  const listingPassword = process.env["LISTING_PASSWORD"];

  res
    .status(200)
    .json({ value: passwordStorageKey, password: listingPassword });
}
