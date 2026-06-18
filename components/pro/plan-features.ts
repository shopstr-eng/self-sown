// Shared Free vs Herd feature lists so the landing page, the /pro upgrade page,
// and the onboarding plan step stay in sync. The Wrangler lifetime tier
// includes everything in Herd.

export const FREE_FEATURES: string[] = [
  "Unlimited product listings",
  "Seller profile & basic stall",
  "Stripe payout setup",
  "Affiliate management",
  "Discount codes",
];

export const PRO_FEATURES: string[] = [
  "Everything in Free",
  "Advanced stall customization",
  "Self-serve custom domains",
  "Automated email flows",
  "Email analytics & engagement stats",
  "Send email from your own domain",
  "Custom product pages",
  "Shippo shipping labels",
  "MCP API access for AI agents",
];

// Wrangler (lifetime) includes everything in Herd PLUS the ability to run your
// OWN private, single-tenant copy of the store (self-host). Listed separately so
// the lifetime card can show the extra perk without implying it's in Herd.
export const WRANGLER_EXTRA_FEATURES: string[] = [
  "Self-host your own private copy of your store",
];
