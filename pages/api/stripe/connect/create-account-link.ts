import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { getStripeConnectAccount } from "@/utils/db/db-service";
import { buildStripeCreateAccountLinkProof } from "@/utils/mcp/request-proof";
import {
  extractSignedEventFromRequest,
  verifyAndConsumeSignedRequestProof,
} from "@/utils/mcp/request-proof-server";
import { ensureConnectAccountCapabilities } from "@/utils/stripe/ensure-capabilities";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";
import { isAllowedPlatformRedirectUrl } from "@/utils/site-url";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-09-30.clover",
});
import { applyRateLimit } from "@/utils/rate-limit";

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function resolveRedirectUrl(params: {
  absoluteUrl?: unknown;
  relativePath?: unknown;
  baseUrl: string;
  defaultPath: string;
}): { ok: true; value: string } | { ok: false; error: string } {
  const absoluteUrl =
    typeof params.absoluteUrl === "string" ? params.absoluteUrl.trim() : "";
  if (absoluteUrl) {
    // The signed proof binds pubkey + accountId but NOT these URLs, so an
    // absolute https target must stay on the platform host — a stolen proof
    // must not be able to return the seller from Stripe onboarding to a
    // lookalike site (isAllowedPlatformRedirectUrl also exempts the
    // selfsown:/milkmarket: app deep-link schemes).
    if (!isAllowedPlatformRedirectUrl(absoluteUrl)) {
      return {
        ok: false,
        error:
          "Redirect URLs must be selfsown:// app links or https URLs on this platform",
      };
    }

    return {
      ok: true,
      value: absoluteUrl,
    };
  }

  const relativePath =
    typeof params.relativePath === "string" && params.relativePath.trim()
      ? params.relativePath.trim()
      : params.defaultPath;

  // Caller-supplied paths must be genuine root-relative paths: anything else
  // (e.g. "@evil.example/x" or "//evil.example/x") concatenated after the
  // baseUrl host would reparse with a DIFFERENT authority — the same
  // lookalike-redirect hole the absolute-URL allowlist closes.
  if (!relativePath.startsWith("/") || relativePath.startsWith("//")) {
    return {
      ok: false,
      error: "Redirect paths must be root-relative (start with a single /)",
    };
  }

  const value = joinUrl(params.baseUrl, relativePath);
  // Tripwire on the FINAL assembled URL: its authority must still be the
  // baseUrl's, no matter what the path contained.
  try {
    if (new URL(value).host !== new URL(params.baseUrl).host) {
      return {
        ok: false,
        error: "Redirect paths must be root-relative (start with a single /)",
      };
    }
  } catch {
    return {
      ok: false,
      error: "Redirect paths must be root-relative (start with a single /)",
    };
  }

  return { ok: true, value };
}

// Rate limit: per-IP cap to bound abuse of payment endpoints.
const RATE_LIMIT = { limit: 30, windowMs: 60000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (
    !(await applyRateLimit(
      req,
      res,
      "stripe-connect-create-account-link",
      RATE_LIMIT
    ))
  )
    return;

  try {
    const {
      accountId,
      returnPath,
      refreshPath,
      returnUrl,
      refreshUrl,
      pubkey,
    } = req.body || {};

    if (!accountId || !pubkey || typeof pubkey !== "string" || !pubkey.trim()) {
      return res
        .status(400)
        .json({ error: "accountId and pubkey are required" });
    }
    const normalizedPubkey = pubkey.trim();

    const signedEvent = extractSignedEventFromRequest(req);
    const proofResult = await verifyAndConsumeSignedRequestProof(
      signedEvent,
      buildStripeCreateAccountLinkProof({
        pubkey: normalizedPubkey,
        accountId,
      })
    );

    if (!proofResult.ok) {
      const authResult = verifyNostrAuth(
        signedEvent,
        normalizedPubkey,
        "stripe-connect",
        { method: "POST", path: "/api/stripe/connect/create-account-link" }
      );
      if (!authResult.valid) {
        return res.status(proofResult.status).json({
          error:
            proofResult.error || authResult.error || "Authentication failed",
        });
      }
    }

    const connectAccount = await getStripeConnectAccount(normalizedPubkey);
    if (!connectAccount || connectAccount.stripe_account_id !== accountId) {
      return res
        .status(403)
        .json({ error: "Account does not belong to this user" });
    }

    const baseUrl =
      process.env.NEXT_PUBLIC_BASE_URL ||
      (process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : "http://localhost:3000");

    const resolvedReturnUrl = resolveRedirectUrl({
      absoluteUrl: returnUrl,
      relativePath: returnPath,
      baseUrl,
      defaultPath: "/onboarding/stripe-connect?success=true",
    });
    if (!resolvedReturnUrl.ok) {
      return res.status(400).json({ error: resolvedReturnUrl.error });
    }

    const resolvedRefreshUrl = resolveRedirectUrl({
      absoluteUrl: refreshUrl,
      relativePath: refreshPath,
      baseUrl,
      defaultPath: "/onboarding/stripe-connect?refresh=true",
    });
    if (!resolvedRefreshUrl.ok) {
      return res.status(400).json({ error: resolvedRefreshUrl.error });
    }

    await ensureConnectAccountCapabilities(stripe, accountId);

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: resolvedRefreshUrl.value,
      return_url: resolvedReturnUrl.value,
      type: "account_onboarding",
    });

    return res.status(200).json({
      url: accountLink.url,
    });
  } catch (error) {
    console.error("Stripe account link creation error:", error);
    return res.status(500).json({
      error: "Failed to create account link",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
