import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import {
  getStripeConnectAccount,
  setStripeTaxEnabled,
} from "@/utils/db/db-service";
import { buildStripeTaxSettingsProof } from "@/utils/mcp/request-proof";
import {
  extractSignedEventFromRequest,
  verifyAndConsumeSignedRequestProof,
} from "@/utils/mcp/request-proof-server";
import { verifyNostrAuth } from "@/utils/stripe/verify-nostr-auth";
import { applyRateLimit } from "@/utils/rate-limit";
import { withStripeRetry } from "@/utils/stripe/retry-service";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-09-30.clover",
});

// Rate limit: per-IP cap to bound abuse of payment endpoints.
const RATE_LIMIT = { limit: 30, windowMs: 60000 };

type Action =
  | "status"
  | "enable"
  | "disable"
  | "add_registration"
  | "remove_registration";

interface RegistrationSummary {
  id: string;
  state: string | null;
  country: string;
  status: string;
  activeFrom: number | null;
  expiresAt: number | null;
}

function summarizeRegistrations(
  list: Stripe.Tax.Registration[]
): RegistrationSummary[] {
  return list.map((reg) => {
    const us = reg.country_options?.us as { state?: string } | undefined;
    return {
      id: reg.id,
      state: us?.state ?? null,
      country: reg.country,
      status: reg.status,
      activeFrom: reg.active_from ?? null,
      expiresAt: reg.expires_at ?? null,
    };
  });
}

// Pull a usable head-office address from the connected account so Stripe Tax
// has an origin to calculate from. Express accounts may store it under company
// or individual depending on business_type.
function resolveHeadOfficeAddress(
  account: Stripe.Account
): Stripe.AddressParam | null {
  const addr =
    account.company?.address ||
    account.individual?.address ||
    (account.business_profile as { support_address?: Stripe.Address } | null)
      ?.support_address ||
    null;
  if (!addr || !addr.country) return null;
  return {
    line1: addr.line1 || undefined,
    line2: addr.line2 || undefined,
    city: addr.city || undefined,
    state: addr.state || undefined,
    postal_code: addr.postal_code || undefined,
    country: addr.country,
  };
}

// Configure the connected account's Stripe Tax origin (head office + default
// tax behavior) so calculations can run. Idempotent — safe to call on every
// enable or registration. Needed because tax is on by default, so most sellers
// add their states without ever hitting the explicit enable step.
async function ensureTaxOriginConfigured(stripeAccount: string): Promise<void> {
  const account = await withStripeRetry(() =>
    stripe.accounts.retrieve(stripeAccount)
  );
  const headOffice = resolveHeadOfficeAddress(account);
  await withStripeRetry(() =>
    stripe.tax.settings.update(
      {
        defaults: { tax_behavior: "exclusive" },
        ...(headOffice ? { head_office: { address: headOffice } } : {}),
      },
      { stripeAccount }
    )
  );
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!applyRateLimit(req, res, "stripe-connect-tax-settings", RATE_LIMIT))
    return;

  try {
    const {
      pubkey,
      action,
      state,
      registrationId,
    }: {
      pubkey?: string;
      action?: Action;
      state?: string;
      registrationId?: string;
    } = req.body || {};

    if (!pubkey || typeof pubkey !== "string" || !pubkey.trim()) {
      return res.status(400).json({ error: "pubkey is required" });
    }
    const normalizedPubkey = pubkey.trim();

    const validActions: Action[] = [
      "status",
      "enable",
      "disable",
      "add_registration",
      "remove_registration",
    ];
    if (!action || !validActions.includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }

    // Auth: signed-event proof (single-use), falling back to generic Nostr auth.
    const signedEvent = extractSignedEventFromRequest(req);
    const proofResult = await verifyAndConsumeSignedRequestProof(
      signedEvent,
      buildStripeTaxSettingsProof(normalizedPubkey)
    );
    if (!proofResult.ok) {
      const authResult = verifyNostrAuth(
        signedEvent,
        normalizedPubkey,
        "stripe-connect",
        { method: "POST", path: "/api/stripe/connect/tax-settings" }
      );
      if (!authResult.valid) {
        return res.status(proofResult.status).json({
          error:
            proofResult.error || authResult.error || "Authentication failed",
        });
      }
    }

    const connectAccount = await getStripeConnectAccount(normalizedPubkey);
    if (!connectAccount) {
      return res.status(400).json({ error: "No Stripe account connected" });
    }
    if (!connectAccount.charges_enabled) {
      return res.status(400).json({
        error: "Finish Stripe onboarding before enabling sales tax collection.",
      });
    }

    const stripeAccount = connectAccount.stripe_account_id;
    const stripeOptions: Stripe.RequestOptions = { stripeAccount };

    // Mutating actions first.
    if (action === "enable") {
      // Set the head office so Stripe Tax has an origin address, then flip flag.
      try {
        await ensureTaxOriginConfigured(stripeAccount);
      } catch (err: any) {
        const msg = err?.raw?.message || err?.message || "Unknown error";
        return res.status(400).json({
          error: `Stripe could not enable tax for your account: ${msg}`,
        });
      }
      await setStripeTaxEnabled(normalizedPubkey, true);
    } else if (action === "disable") {
      await setStripeTaxEnabled(normalizedPubkey, false);
    } else if (action === "add_registration") {
      const st = (state || "").trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(st)) {
        return res
          .status(400)
          .json({ error: "A valid US state code is required" });
      }
      // Tax is on by default, so sellers can reach this without ever clicking
      // enable. Make sure the Stripe Tax origin is configured first, or the
      // registration would exist while calculations silently return $0.
      try {
        await ensureTaxOriginConfigured(stripeAccount);
      } catch (err: any) {
        const msg = err?.raw?.message || err?.message || "Unknown error";
        return res.status(400).json({
          error: `Stripe could not set up tax for your account: ${msg}`,
        });
      }
      try {
        await withStripeRetry(() =>
          stripe.tax.registrations.create(
            {
              country: "US",
              country_options: {
                us: { state: st, type: "state_sales_tax" },
              },
              active_from: "now",
            },
            stripeOptions
          )
        );
      } catch (err: any) {
        const msg = err?.raw?.message || err?.message || "Unknown error";
        return res.status(400).json({ error: `Could not add ${st}: ${msg}` });
      }
    } else if (action === "remove_registration") {
      if (!registrationId || typeof registrationId !== "string") {
        return res.status(400).json({ error: "registrationId is required" });
      }
      try {
        // Registrations can't be deleted; expire immediately so calculations
        // stop using the jurisdiction.
        await withStripeRetry(() =>
          stripe.tax.registrations.update(
            registrationId,
            { expires_at: "now" },
            stripeOptions
          )
        );
      } catch (err: any) {
        const msg = err?.raw?.message || err?.message || "Unknown error";
        return res
          .status(400)
          .json({ error: `Could not remove registration: ${msg}` });
      }
    }

    // Always return the latest combined status.
    let settingsStatus: string | null = null;
    let settingsStatusDetail: string | null = null;
    try {
      const settings = await withStripeRetry(() =>
        stripe.tax.settings.retrieve(stripeOptions)
      );
      settingsStatus = settings.status;
      const pending = settings.status_details?.pending as
        | { missing_fields?: string[] }
        | undefined;
      if (pending?.missing_fields?.length) {
        settingsStatusDetail = `Missing: ${pending.missing_fields.join(", ")}`;
      }
    } catch {
      settingsStatus = "unavailable";
    }

    let registrations: RegistrationSummary[] = [];
    try {
      const regList = await withStripeRetry(() =>
        stripe.tax.registrations.list({ status: "active" }, stripeOptions)
      );
      registrations = summarizeRegistrations(regList.data).filter(
        (r) => r.country === "US"
      );
    } catch {
      registrations = [];
    }

    // Re-read the flag in case this request changed it.
    const fresh = await getStripeConnectAccount(normalizedPubkey);

    return res.status(200).json({
      success: true,
      taxEnabled: fresh?.tax_enabled ?? false,
      settingsStatus,
      settingsStatusDetail,
      registrations,
    });
  } catch (error) {
    console.error("Stripe tax settings error:", error);
    return res.status(500).json({
      error: "Failed to update tax settings",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
