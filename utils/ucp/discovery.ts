import {
  UCP_CATALOG_CAPABILITY,
  UCP_CHECKOUT_CAPABILITY,
  UCP_VENDOR_NAMESPACE,
  UCP_VERSION,
} from "./types";

/**
 * Builder for the Universal Commerce Protocol (UCP) discovery profile served at
 * `/.well-known/ucp`. Pure and synchronous so it can be unit-tested for both the
 * platform-wide (aggregate) and seller-scoped variants without a request.
 *
 * The profile is the entry point an agentic/shopping client reads to learn:
 *   - which UCP capabilities this host supports (catalog + checkout),
 *   - the concrete REST endpoints + machine-readable schema/spec for each,
 *   - the accepted payment methods, and
 *   - vendor (Nostr/MCP) extensions under the reverse-DNS namespace.
 *
 * Scope:
 *   - Platform host → an *aggregate* profile describing the whole marketplace.
 *   - A seller's custom domain (or a self-host instance) → a *seller-scoped*
 *     profile naming the one seller; the catalog/checkout endpoints are the same
 *     relative paths but resolve to that seller because they're served on the
 *     seller's host (the proxy scopes them by host).
 */

export interface UcpDiscoverySeller {
  /** Nostr pubkey (hex). */
  pubkey: string;
  /** Bech32 npub. */
  npub: string;
  /** Seller display name, when known. */
  name?: string;
  /** Storefront slug, when known. */
  slug?: string;
}

export interface BuildDiscoveryOpts {
  /** Absolute base URL for this host (platform or seller domain). */
  baseUrl: string;
  /** When set, the profile is scoped to this single seller. */
  seller?: UcpDiscoverySeller | null;
}

/** Payment methods always available marketplace-wide. */
const BASE_PAYMENT_METHODS = [
  {
    method: "lightning",
    description: "Bitcoin Lightning Network (BOLT11 invoice)",
    currencies: ["XBT"],
  },
  {
    method: "cashu",
    description: "Cashu ecash tokens",
    currencies: ["XBT"],
  },
  {
    method: "stripe",
    description: "Credit/debit card via Stripe (seller-dependent)",
    currencies: ["USD"],
  },
  {
    method: "fiat",
    description:
      "Manual fiat transfer, e.g. Venmo/Cash App/Zelle (seller-dependent)",
    currencies: ["USD"],
  },
];

export interface UcpDiscoveryProfile {
  ucp_version: string;
  supported_versions: string[];
  name: string;
  description: string;
  scope: "marketplace" | "seller";
  provider: {
    name: string;
    url: string;
    namespace: string;
  };
  seller?: {
    pubkey: string;
    npub: string;
    name?: string;
    url: string;
  };
  capabilities: Array<Record<string, unknown>>;
  authentication: Record<string, unknown>;
  ext: Record<string, unknown>;
}

export function buildUcpDiscoveryProfile(
  opts: BuildDiscoveryOpts
): UcpDiscoveryProfile {
  const base = (opts.baseUrl || "").replace(/\/$/, "");
  const seller = opts.seller || null;
  const scoped = !!seller;

  // Every capability is reachable two ways: the UCP-native REST endpoints and
  // the vendor MCP server (same backing logic). Advertise both as transports so
  // an agent can pick whichever it already speaks.
  const mcpTransport = {
    type: "mcp",
    endpoint: `${base}/api/mcp`,
    manifest: `${base}/.well-known/agent.json`,
  };

  const catalogEndpoints = {
    search: `${base}/api/ucp/catalog/search`,
    lookup: `${base}/api/ucp/catalog/lookup`,
  };

  const catalogCapability: Record<string, unknown> = {
    name: UCP_CATALOG_CAPABILITY,
    version: UCP_VERSION,
    description: scoped
      ? "Browse and look up this seller's products."
      : "Search and look up products across the whole marketplace.",
    endpoints: catalogEndpoints,
    schema: `${base}/api/ucp/schemas/product.json`,
    spec: `${base}/api/openapi.json`,
    transports: [
      {
        type: "rest",
        endpoints: catalogEndpoints,
        schema: `${base}/api/ucp/schemas/product.json`,
        spec: `${base}/api/openapi.json`,
      },
      mcpTransport,
    ],
  };

  const checkoutEndpoints = {
    create_session: `${base}/api/ucp/checkout/sessions`,
    get_session: `${base}/api/ucp/checkout/sessions/{id}`,
    complete_session: `${base}/api/ucp/checkout/sessions/{id}/complete`,
  };

  const checkoutCapability: Record<string, unknown> = {
    name: UCP_CHECKOUT_CAPABILITY,
    version: UCP_VERSION,
    description:
      "Create and track a checkout session that places an order through Milk Market's existing order pipeline.",
    endpoints: checkoutEndpoints,
    schema: `${base}/api/ucp/schemas/checkout-session.json`,
    spec: `${base}/api/openapi.json`,
    paymentMethods: BASE_PAYMENT_METHODS,
    transports: [
      {
        type: "rest",
        endpoints: checkoutEndpoints,
        schema: `${base}/api/ucp/schemas/checkout-session.json`,
        spec: `${base}/api/openapi.json`,
      },
      mcpTransport,
    ],
    authentication: {
      type: "bearer",
      tokenPrefix: "sk_",
      scope: "read_write",
      description:
        "Creating a checkout session requires a read_write (or full_access) Milk Market API key. Obtain one via POST /api/mcp/onboard.",
    },
  };

  const profile: UcpDiscoveryProfile = {
    ucp_version: UCP_VERSION,
    supported_versions: [UCP_VERSION],
    name: scoped ? seller!.name || "Milk Market Seller" : "Milk Market",
    description: scoped
      ? "UCP commerce profile for an independent seller on Milk Market, a permissionless Bitcoin-native marketplace built on Nostr."
      : "UCP commerce profile for Milk Market, a permissionless Bitcoin-native marketplace for local food built on Nostr.",
    scope: scoped ? "seller" : "marketplace",
    provider: {
      name: "Milk Market",
      url: base,
      namespace: UCP_VENDOR_NAMESPACE,
    },
    capabilities: [catalogCapability, checkoutCapability],
    authentication: {
      type: "bearer",
      tokenPrefix: "sk_",
      scopes: ["read", "read_write", "full_access"],
      onboarding: `${base}/api/mcp/onboard`,
      description:
        "Browsing the catalog is open; placing an order requires a read_write API key. Account/stall management requires full_access.",
    },
    ext: {
      [UCP_VENDOR_NAMESPACE]: {
        mcp: `${base}/api/mcp`,
        agentManifest: `${base}/.well-known/agent.json`,
        l402: `${base}/.well-known/l402.json`,
        protocol: "nostr",
        eventKind: 30402,
      },
    },
  };

  if (scoped && seller) {
    profile.seller = {
      pubkey: seller.pubkey,
      npub: seller.npub,
      ...(seller.name ? { name: seller.name } : {}),
      // On a seller-scoped host the base URL IS the seller's storefront root.
      url: base,
    };
  }

  return profile;
}
