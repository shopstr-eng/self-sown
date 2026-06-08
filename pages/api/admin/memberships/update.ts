import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { requireAdmin } from "@/utils/admin/auth";
import {
  adminGrantLifetimeMembership,
  adminGrantProMembership,
  adminRevokeMembership,
  getMembershipView,
} from "@/utils/pro/membership";
import { normalizePubkey } from "./index";

const RATE_LIMIT = { limit: 20, windowMs: 60 * 1000 };

const VALID_OPS = ["grant-pro", "grant-lifetime", "revoke"] as const;
type Op = (typeof VALID_OPS)[number];

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!applyRateLimit(req, res, "admin-membership-update", RATE_LIMIT)) return;
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const pubkey = normalizePubkey(req.body?.pubkey);
  if (!pubkey) {
    return res
      .status(400)
      .json({ error: "A valid seller npub or hex pubkey is required" });
  }

  const op = req.body?.op as Op | undefined;
  if (!op || !VALID_OPS.includes(op)) {
    return res
      .status(400)
      .json({ error: `op must be one of: ${VALID_OPS.join(", ")}` });
  }

  // months is only meaningful for grant-pro. Bind it into the auth proof even
  // for other ops (as "0") so the signed event commits to the exact request.
  let months = 0;
  if (op === "grant-pro") {
    months = Number(req.body?.months);
    if (!Number.isInteger(months) || months < 1 || months > 120) {
      return res
        .status(400)
        .json({ error: "months must be an integer between 1 and 120" });
    }
  }

  const admin = requireAdmin(req, res, "admin-membership-update", {
    method: "POST",
    path: "/api/admin/memberships/update",
    fields: { pubkey, op, months: String(months) },
  });
  if (!admin) return; // requireAdmin already wrote the response

  try {
    if (op === "grant-pro") {
      await adminGrantProMembership(pubkey, months);
    } else if (op === "grant-lifetime") {
      await adminGrantLifetimeMembership(pubkey);
    } else {
      await adminRevokeMembership(pubkey);
    }
    const view = await getMembershipView(pubkey);
    return res.status(200).json({ ok: true, view });
  } catch (error) {
    console.error("Admin membership update error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
