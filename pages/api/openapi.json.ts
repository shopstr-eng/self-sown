import type { NextApiRequest, NextApiResponse } from "next";

const BASE_URL = "https://milk.market";

// Optional major-version pin documented on every /api operation (enforced in
// proxy.ts; see x-versioning-policy).
const API_VERSION_PARAM = { $ref: "#/components/parameters/ApiVersion" };

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Milk Market API",
      version: "2.2.0",
      description:
        "Public and agent-facing endpoints for Milk Market, a permissionless Bitcoin-native marketplace for local food built on Nostr. Programmatic marketplace participation (search, ordering, stall management) is provided by the Model Context Protocol (MCP) server at /api/mcp using JSON-RPC 2.0; the endpoints below cover discovery, feeds, and the MCP entry point.",
      contact: { name: "Milk Market", url: `${BASE_URL}/contact` },
      license: {
        name: "MIT",
        url: "https://github.com/shopstr-eng/milk-market",
      },
    },
    servers: [{ url: BASE_URL }],
    "x-versioning-policy": {
      scheme: "semver",
      current: "2.2.0",
      description:
        "This document is semantically versioned. Breaking changes (removed or renamed fields/endpoints, newly required parameters) ship only in a new major version. Additive changes (new endpoints, new optional fields, new enum values) can ship at any time — clients MUST ignore unknown fields. Every /api/* response carries an API-Version header with the served major version; agents may pin a version by sending the API-Version request header, and an unsupported pin fails closed with a 400 unsupported_api_version error. Deprecated operations carry the Deprecation response header and, once a removal date is set, the Sunset header (RFC 8594), at least 90 days before removal.",
      policyUrl: `${BASE_URL}/developers#versioning`,
    },
    paths: {
      "/api/mcp": {
        post: {
          operationId: "mcpRpc",
          summary: "Model Context Protocol JSON-RPC 2.0 endpoint",
          description:
            "Streamable HTTP MCP endpoint. Send JSON-RPC 2.0 requests to list and call tools (search_products, get_product_details, create_order, etc.). The initialize handshake, tools/list, resources/list, and the public read tools work WITHOUT an API key (a presented-but-invalid key is rejected with 401); purchasing requires a read_write key and account/stall management requires a full_access key. Unauthenticated initialize is capped at 30 requests/minute and 5 concurrent sessions per IP; all 429 responses (global, per-key, anonymous-initialize, and the concurrent-session cap) use the shared RateLimited body. Clients SHOULD send Accept: application/json, text/event-stream per the Streamable HTTP transport; missing or incomplete Accept headers are tolerated on POST. Responses arrive as an SSE stream (content-type text/event-stream) carrying JSON-RPC envelopes.",
          security: [{ bearerAuth: [] }, {}],
          parameters: [API_VERSION_PARAM],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    jsonrpc: { type: "string", enum: ["2.0"] },
                    id: { type: ["string", "number", "null"] },
                    method: { type: "string" },
                    params: { type: "object" },
                  },
                  required: ["jsonrpc", "method"],
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "JSON-RPC result envelope, or an SSE stream carrying JSON-RPC envelopes",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["jsonrpc", "id"],
                    properties: {
                      jsonrpc: { type: "string", enum: ["2.0"] },
                      result: {
                        type: "object",
                        description:
                          "Method-specific result (e.g. initialize returns protocolVersion, capabilities, serverInfo).",
                        additionalProperties: true,
                      },
                      id: { type: ["string", "number", "null"] },
                    },
                  },
                },
                "text/event-stream": {
                  schema: {
                    type: "string",
                    description:
                      "SSE stream; each event's data payload is a complete JSON-RPC envelope.",
                  },
                },
              },
            },
            "401": { $ref: "#/components/responses/McpUnauthorized" },
            "403": { $ref: "#/components/responses/McpForbidden" },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/api/mcp/status": {
        get: {
          operationId: "mcpStatus",
          summary: "MCP server status",
          description:
            "Liveness and marketplace-corpus freshness: product, company, and review counts with last-updated timestamps, so an agent can decide whether cached results are stale before searching.",
          parameters: [API_VERSION_PARAM],
          responses: {
            "200": {
              description: "Status payload",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["data", "version", "_meta"],
                    properties: {
                      data: {
                        type: "object",
                        description:
                          "Marketplace corpus counts with last-updated timestamps.",
                        properties: {
                          products: {
                            $ref: "#/components/schemas/CorpusStat",
                          },
                          companies: {
                            $ref: "#/components/schemas/CorpusStat",
                          },
                          reviews: {
                            $ref: "#/components/schemas/CorpusStat",
                          },
                        },
                      },
                      version: { type: "string" },
                      _meta: {
                        type: "object",
                        properties: {
                          responseTimeMs: { type: "number" },
                          generatedAt: {
                            type: "string",
                            format: "date-time",
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/rss.xml": {
        get: {
          operationId: "productFeed",
          summary: "RSS 2.0 feed of recent product listings",
          description:
            "RSS 2.0 feed of the most recent product listings across the marketplace; poll it to watch for new inventory without an API key.",
          responses: {
            "200": {
              description: "RSS feed",
              content: {
                "application/rss+xml": {
                  schema: {
                    type: "string",
                    description: "RSS 2.0 XML document.",
                  },
                },
              },
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/sitemap.xml": {
        get: {
          operationId: "sitemap",
          summary: "XML sitemap",
          description:
            "XML sitemap of public pages, stalls, and listings for crawlers and discovery-oriented agents.",
          responses: {
            "200": {
              description: "Sitemap",
              content: {
                "application/xml": {
                  schema: {
                    type: "string",
                    description: "Sitemap XML document.",
                  },
                },
              },
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/llms.txt": {
        get: {
          operationId: "llmsTxt",
          summary: "Plain-text site description for LLMs",
          description:
            "LLM-oriented site orientation: what Milk Market is, when to use it, and links to every machine-readable surface. A good first read for any agent.",
          responses: {
            "200": {
              description: "llms.txt",
              content: {
                "text/markdown": {
                  schema: {
                    type: "string",
                    description:
                      "Markdown document following the llms.txt convention.",
                  },
                },
              },
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/.well-known/mcp.json": {
        get: {
          operationId: "mcpDiscovery",
          summary: "MCP discovery document",
          description:
            "MCP server manifest: transport type, endpoint URL, and authentication scheme. Read this first when connecting an MCP client by URL.",
          responses: {
            "200": {
              description: "MCP discovery JSON",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/McpDiscoveryDoc" },
                },
              },
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/.well-known/agent-card.json": {
        get: {
          operationId: "agentCard",
          summary: "Google A2A agent card",
          description:
            "Agent-to-Agent (A2A) card: capabilities, example skills, auth scheme, and the JSONRPC endpoint for agent-to-agent integration.",
          responses: {
            "200": {
              description: "Agent card JSON",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/AgentCardDoc" },
                },
              },
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/.well-known/l402.json": {
        get: {
          operationId: "l402Discovery",
          summary:
            "L402 discovery document (facilitator-agnostic HTTP 402 payments)",
          description:
            "Facilitator-agnostic L402 discovery: the WWW-Authenticate challenge format, the Authorization credential format, settlement verification, and the resources that accept pay-per-request Lightning payments.",
          responses: {
            "200": {
              description: "L402 discovery JSON",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/L402DiscoveryDoc" },
                },
              },
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/.well-known/ucp": {
        get: {
          operationId: "ucpDiscovery",
          summary:
            "Universal Commerce Protocol (UCP) discovery profile (catalog + checkout capabilities)",
          description:
            "Aggregate marketplace profile on the platform host; a single-seller profile on a seller's custom domain or self-host instance.",
          responses: {
            "200": {
              description: "UCP discovery JSON",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/UcpDiscoveryProfile" },
                },
              },
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/api/ucp/catalog/search": {
        get: {
          operationId: "ucpCatalogSearch",
          summary: "UCP catalog search",
          description:
            "Search products (host-scoped to one seller on a seller domain). Supports q, category, availability, location, limit, offset.",
          parameters: [
            API_VERSION_PARAM,
            {
              name: "q",
              in: "query",
              required: false,
              description: "Full-text search query (alias: query).",
              schema: { type: "string" },
            },
            {
              name: "category",
              in: "query",
              required: false,
              description: "Category filter (alias: t).",
              schema: { type: "string" },
            },
            {
              name: "availability",
              in: "query",
              required: false,
              description: "Availability filter, e.g. in_stock.",
              schema: { type: "string" },
            },
            {
              name: "location",
              in: "query",
              required: false,
              description: "Free-text location filter.",
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              description: "Page size (server-clamped).",
              schema: { type: "integer", minimum: 1 },
            },
            {
              name: "offset",
              in: "query",
              required: false,
              description: "Pagination offset.",
              schema: { type: "integer", minimum: 0, default: 0 },
            },
            {
              name: "seller",
              in: "query",
              required: false,
              description:
                "Restrict results to one seller by pubkey (alias: pubkey).",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Matching UCP products + query context",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["products", "context"],
                    properties: {
                      products: {
                        type: "array",
                        items: {
                          $ref: "#/components/schemas/UcpProduct",
                        },
                      },
                      context: {
                        type: "object",
                        description:
                          "Echo of the resolved scope and query filters, plus pagination (total, limit, offset).",
                        properties: {
                          total: { type: "integer" },
                          limit: { type: "integer" },
                          offset: { type: "integer" },
                          scope: {
                            type: "string",
                            enum: ["marketplace", "seller"],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/api/ucp/catalog/lookup": {
        get: {
          operationId: "ucpCatalogLookup",
          summary: "UCP product lookup",
          description:
            "Look up a single product by id, d-tag, or slug, with live inventory + accepted payment methods.",
          parameters: [
            API_VERSION_PARAM,
            {
              name: "id",
              in: "query",
              required: false,
              description: "Product event id (alias: event_id).",
              schema: { type: "string" },
            },
            {
              name: "d",
              in: "query",
              required: false,
              description: "Nostr d-tag (alias: d_tag).",
              schema: { type: "string" },
            },
            {
              name: "slug",
              in: "query",
              required: false,
              description: "URL slug of the listing.",
              schema: { type: "string" },
            },
            {
              name: "seller",
              in: "query",
              required: false,
              description:
                "Seller pubkey to disambiguate d-tag/slug lookups (alias: pubkey).",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "A single UCP product",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["product"],
                    properties: {
                      product: {
                        $ref: "#/components/schemas/UcpProduct",
                      },
                      context: {
                        type: "object",
                        description:
                          "Resolved scope plus navigation links (self, search, checkout).",
                      },
                    },
                  },
                },
              },
            },
            "404": {
              $ref: "#/components/responses/NotFound",
              description: "Product not found",
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/api/ucp/checkout/sessions": {
        post: {
          operationId: "ucpCreateCheckoutSession",
          summary: "Create a UCP checkout session",
          description:
            "Creates AND initializes a checkout session in one call by placing an order through Milk Market's existing order pipeline. Requires a read_write API key. Recoverable problems (e.g. no exchange rate to price a fiat order in sats) return HTTP 200 with a session whose status is 'requires_escalation' rather than an error status.",
          security: [{ bearerAuth: [] }],
          parameters: [API_VERSION_PARAM],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["productId"],
                  properties: {
                    productId: {
                      type: "string",
                      description: "Product id from the catalog.",
                    },
                    variantId: {
                      type: "string",
                      description:
                        'Catalog variant id (e.g. "size:1 Gallon"); decoded into the order-engine selection. An explicit selected* field still wins.',
                    },
                    quantity: {
                      type: "integer",
                      minimum: 1,
                      default: 1,
                    },
                    buyerEmail: {
                      type: "string",
                      format: "email",
                      description: "Buyer contact for order updates.",
                    },
                    shippingAddress: {
                      type: "object",
                      description: "Delivery address for shipped orders.",
                      additionalProperties: true,
                    },
                    selectedSize: { type: "string" },
                    selectedVolume: { type: "string" },
                    selectedWeight: { type: "string" },
                    selectedBulkUnits: {
                      type: "string",
                      description: "Bulk-pack selection, when offered.",
                    },
                    discountCode: { type: "string" },
                    paymentMethod: {
                      type: "string",
                      enum: ["stripe", "lightning", "cashu", "fiat"],
                      default: "stripe",
                    },
                    mintUrl: {
                      type: "string",
                      format: "uri",
                      description: "Cashu mint URL (cashu payments).",
                    },
                    cashuToken: {
                      type: "string",
                      description: "Pre-built Cashu token (cashu payments).",
                    },
                    fiatMethod: {
                      type: "string",
                      description: "Manual fiat rail label (fiat payments).",
                    },
                  },
                  additionalProperties: true,
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Checkout session in a 'requires_escalation' state (a recoverable problem the buyer/seller must resolve out of band)",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/UcpCheckoutSession",
                  },
                },
              },
            },
            "201": {
              description: "Checkout session created",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/UcpCheckoutSession",
                  },
                },
              },
            },
            "400": {
              $ref: "#/components/responses/BadRequest",
              description: "Missing or invalid productId",
            },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": {
              $ref: "#/components/responses/Forbidden",
              description: "Product not sold on this storefront",
            },
            "404": {
              $ref: "#/components/responses/NotFound",
              description: "Product not found",
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
        get: {
          operationId: "ucpListCheckoutSessions",
          summary: "List the authenticated key's checkout sessions",
          description:
            "Lists checkout sessions created by the authenticated API key, newest first. Read-only keys can list; creation requires read_write.",
          security: [{ bearerAuth: [] }],
          parameters: [API_VERSION_PARAM],
          responses: {
            "200": {
              description: "Checkout sessions",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      $ref: "#/components/schemas/UcpCheckoutSession",
                    },
                  },
                },
              },
            },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/api/ucp/checkout/sessions/{id}": {
        get: {
          operationId: "ucpGetCheckoutSession",
          summary: "Read one checkout session (owner-only)",
          description:
            "Returns the session with its status reconciled against the canonical order payment status.",
          security: [{ bearerAuth: [] }],
          parameters: [
            API_VERSION_PARAM,
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Checkout session",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/UcpCheckoutSession",
                  },
                },
              },
            },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "404": {
              $ref: "#/components/responses/NotFound",
              description: "Checkout session not found",
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/api/ucp/checkout/sessions/{id}/complete": {
        post: {
          operationId: "ucpCompleteCheckoutSession",
          summary: "Complete a checkout session (owner-only)",
          description:
            "Explicitly completes a session: reconciles it against the canonical order payment status (paid→completed, processing/pending→complete_in_progress, failed→requires_escalation, refunded→canceled). Idempotent. Requires a read_write API key.",
          security: [{ bearerAuth: [] }],
          parameters: [
            API_VERSION_PARAM,
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Checkout session after completion reconcile",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/UcpCheckoutSession",
                  },
                },
              },
            },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "404": {
              $ref: "#/components/responses/NotFound",
              description: "Checkout session not found",
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/api/ucp/schemas/product.json": {
        get: {
          operationId: "ucpProductSchema",
          summary: "JSON Schema for the UCP product shape",
          description:
            "Canonical draft 2020-12 JSON Schema describing the UCP product shape returned by the catalog endpoints; validate or introspect responses against it.",
          parameters: [API_VERSION_PARAM],
          responses: {
            "200": {
              description: "JSON Schema (draft 2020-12)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/JsonSchemaDocument" },
                },
              },
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
      "/api/ucp/schemas/checkout-session.json": {
        get: {
          operationId: "ucpCheckoutSessionSchema",
          summary: "JSON Schema for the UCP checkout session shape",
          description:
            "Canonical draft 2020-12 JSON Schema describing the UCP checkout session shape, including the status lifecycle enum.",
          parameters: [API_VERSION_PARAM],
          responses: {
            "200": {
              description: "JSON Schema (draft 2020-12)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/JsonSchemaDocument" },
                },
              },
            },
            "429": { $ref: "#/components/responses/RateLimited" },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "API key with prefix sk_ and one of three scopes: read, read_write, full_access.",
        },
      },
      parameters: {
        ApiVersion: {
          name: "API-Version",
          in: "header",
          required: false,
          description:
            "Optional major-version pin. Every /api/* response carries the served version in the API-Version response header; an unsupported request value fails closed with a 400 unsupported_api_version error. Omit to track the latest version.",
          schema: { type: "string", enum: ["2"], default: "2" },
        },
      },
      schemas: {
        JsonRpcError: {
          type: "object",
          description:
            "JSON-RPC 2.0 error envelope used by the MCP endpoint for protocol and authentication failures (instead of the REST Error shape).",
          required: ["jsonrpc", "error", "id"],
          properties: {
            jsonrpc: { type: "string", enum: ["2.0"] },
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: {
                  type: "integer",
                  description:
                    "JSON-RPC error code (application errors use -32000)",
                },
                message: { type: "string" },
              },
            },
            id: { type: ["string", "number", "null"] },
          },
        },
        CorpusStat: {
          type: "object",
          properties: {
            count: { type: "integer" },
            lastUpdated: {
              type: ["string", "null"],
              format: "date-time",
            },
          },
        },
        Money: {
          type: "object",
          description:
            "An amount in a currency's minor units, with display metadata.",
          required: ["currency", "amount", "exponent", "display"],
          properties: {
            currency: {
              type: "string",
              description:
                'ISO 4217 code, or "XBT" for bitcoin-denominated prices.',
            },
            amount: {
              type: "integer",
              description:
                "Integer amount in the currency's minor units (cents, sats, or whole units for zero-decimal currencies).",
            },
            exponent: {
              type: "integer",
              description: "Minor units per major unit are 10^exponent.",
            },
            display: {
              type: "string",
              description: "Human-readable formatted amount.",
            },
          },
        },
        UcpProduct: {
          type: "object",
          description: `Universal Commerce Protocol representation of a Milk Market listing (NIP-99 kind:30402). Condensed view for in-document tooling — the canonical full JSON Schema is served at ${BASE_URL}/api/ucp/schemas/product.json. Unknown fields may be added at any time.`,
          required: ["id", "type", "title", "url", "price", "availability"],
          properties: {
            id: { type: "string", description: "Nostr event id." },
            type: { type: "string", enum: ["product"] },
            title: { type: "string" },
            description: { type: "string" },
            url: {
              type: "string",
              format: "uri",
              description: "Canonical product URL (host-scoped).",
            },
            images: {
              type: "array",
              items: { type: "string", format: "uri" },
            },
            price: { $ref: "#/components/schemas/Money" },
            categories: { type: "array", items: { type: "string" } },
            availability: {
              type: "object",
              description: "Availability state plus optional restock metadata.",
              additionalProperties: true,
            },
            seller: {
              type: "object",
              description: "Seller identity (pubkey, stall, domain).",
              additionalProperties: true,
            },
            location: { type: "string" },
            shipping: {
              type: "object",
              description: "Shipping options and handling time.",
              additionalProperties: true,
            },
            paymentMethods: {
              type: "array",
              items: { type: "string" },
              description:
                "Accepted payment methods (always lightning + cashu; stripe when the seller enables it).",
            },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        UcpCheckoutSession: {
          type: "object",
          description: `UCP checkout session. Condensed view — the canonical full JSON Schema is served at ${BASE_URL}/api/ucp/schemas/checkout-session.json.`,
          required: ["id", "status", "paymentMethod", "amount", "currency"],
          properties: {
            id: {
              type: "string",
              description: "Session id (ucp_cs_…).",
            },
            status: {
              type: "string",
              description:
                "UCP checkout lifecycle: incomplete → ready_for_complete → complete_in_progress → completed, plus requires_escalation and canceled.",
              enum: [
                "incomplete",
                "ready_for_complete",
                "complete_in_progress",
                "completed",
                "requires_escalation",
                "canceled",
              ],
            },
            buyer: {
              type: "object",
              properties: { pubkey: { type: "string" } },
            },
            seller: {
              type: "object",
              properties: { pubkey: { type: "string" } },
            },
            productId: { type: "string" },
            orderId: {
              type: "string",
              description: "Underlying Milk Market order id, when created.",
            },
            paymentMethod: {
              type: "string",
              enum: ["stripe", "lightning", "cashu", "fiat"],
            },
            amount: {
              type: "number",
              description: "Order total in major units.",
            },
            currency: { type: "string" },
            payment: {
              type: ["object", "null"],
              description:
                "Method-specific payment descriptor (e.g. Lightning bolt11 invoice, Stripe clientSecret, fiat instructions).",
              additionalProperties: true,
            },
            quote: {
              type: "object",
              description: "Pricing breakdown for the order, when available.",
              additionalProperties: true,
            },
            messages: {
              type: "array",
              description: "Human/agent-readable timeline entries.",
              items: {
                type: "object",
                required: ["type", "text", "at"],
                properties: {
                  type: { type: "string" },
                  text: { type: "string" },
                  at: { type: "string", format: "date-time" },
                  severity: {
                    type: "string",
                    enum: ["info", "warning", "error"],
                  },
                },
              },
            },
            error: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            links: {
              type: "object",
              properties: {
                self: { type: "string", format: "uri" },
                discovery: { type: "string", format: "uri" },
              },
            },
          },
        },
        McpDiscoveryDoc: {
          type: "object",
          description:
            "MCP server manifest (modelcontextprotocol.io mcp.json schema).",
          required: ["name", "version", "transport"],
          properties: {
            name: { type: "string" },
            version: { type: "string" },
            description: { type: "string" },
            homepage: { type: "string", format: "uri" },
            documentation: { type: "string", format: "uri" },
            transport: {
              type: "object",
              required: ["type", "endpoint"],
              properties: {
                type: { type: "string", enum: ["streamable-http"] },
                jsonrpc: { type: "string", enum: ["2.0"] },
                endpoint: { type: "string", format: "uri" },
              },
            },
          },
        },
        AgentCardDoc: {
          type: "object",
          description: "Google A2A protocol agent card.",
          required: ["name", "url", "capabilities"],
          properties: {
            protocolVersion: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            url: { type: "string", format: "uri" },
            preferredTransport: { type: "string" },
            documentationUrl: { type: "string", format: "uri" },
            capabilities: {
              type: "object",
              properties: {
                streaming: { type: "boolean" },
                pushNotifications: { type: "boolean" },
              },
            },
            skills: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "name", "description"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  description: { type: "string" },
                  tags: { type: "array", items: { type: "string" } },
                  examples: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        L402DiscoveryDoc: {
          type: "object",
          description:
            "Facilitator-agnostic L402 (HTTP 402 Lightning payment) discovery document.",
          required: ["version", "scheme"],
          properties: {
            version: { type: "string" },
            scheme: { type: "string", enum: ["L402"] },
            name: { type: "string" },
            description: { type: "string" },
            documentation: { type: "string", format: "uri" },
            authentication: {
              type: "object",
              properties: {
                challengeHeader: { type: "string" },
                challengeFormat: { type: "string" },
                authorizationHeader: { type: "string" },
                authorizationFormat: { type: "string" },
                tokenType: { type: "string" },
              },
            },
            payment: {
              type: "object",
              properties: {
                network: { type: "string" },
                currency: { type: "string" },
                invoiceFormat: { type: "string" },
                facilitatorAgnostic: { type: "boolean" },
              },
            },
          },
        },
        UcpDiscoveryProfile: {
          type: "object",
          description:
            "UCP discovery profile advertising the catalog and checkout capabilities with both REST and MCP transports.",
          required: ["ucp_version", "capabilities"],
          properties: {
            ucp_version: { type: "string" },
            supported_versions: {
              type: "array",
              items: { type: "string" },
            },
            scope: { type: "string", enum: ["marketplace", "seller"] },
            name: { type: "string" },
            seller: {
              type: "object",
              description: "Present on single-seller (custom-domain) profiles.",
              additionalProperties: true,
            },
            capabilities: {
              type: "array",
              items: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  version: { type: "string" },
                },
                additionalProperties: true,
              },
            },
          },
        },
        JsonSchemaDocument: {
          type: "object",
          description: "A JSON Schema (draft 2020-12) document.",
          properties: {
            $schema: { type: "string", format: "uri" },
            $id: { type: "string", format: "uri" },
            title: { type: "string" },
            type: { type: "string" },
            properties: { type: "object", additionalProperties: true },
          },
        },
        Error: {
          type: "object",
          description:
            "Error body contract. Every error response carries a human-readable `error` string. Agent-facing endpoints (catch-all 404s, MCP, and other machine-readable surfaces) additionally return the stable machine-readable `code` plus discovery hints; branch on `code`, never on prose. Unknown fields may be added at any time.",
          required: ["error"],
          properties: {
            error: {
              type: "string",
              description: "Short human-readable summary (always present)",
            },
            code: {
              type: "string",
              description:
                "Stable machine-readable code, e.g. not_found or rate_limited",
            },
            status: {
              type: "integer",
              description: "HTTP status code echoed in the body",
            },
            message: { type: "string" },
            path: { type: "string" },
            method: { type: "string" },
            slug: { type: "string" },
            details: { type: "string" },
            retryAfterSeconds: {
              type: "integer",
              description: "Present on 429 responses",
            },
            documentation: {
              type: "object",
              description: "Links back to the machine-readable docs",
              properties: {
                openapi: { type: "string", format: "uri" },
                mcp: { type: "string", format: "uri" },
                agents: { type: "string", format: "uri" },
              },
            },
          },
        },
      },
      responses: {
        McpUnauthorized: {
          description:
            "Presented API key is invalid or revoked (JSON-RPC error envelope)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/JsonRpcError" },
            },
          },
        },
        McpForbidden: {
          description:
            "API key is valid but the owning seller's MCP access is inactive (JSON-RPC error envelope)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/JsonRpcError" },
            },
          },
        },
        BadRequest: {
          description:
            "Malformed request — missing/invalid required fields, or an unsupported API-Version header value",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        Unauthorized: {
          description: "Missing, invalid, or revoked API key",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        Forbidden: {
          description:
            "Authenticated but not permitted (key scope, resource ownership, or membership tier)",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        NotFound: {
          description:
            "Resource not found. Non-API routes additionally honor content negotiation: Accept: text/markdown returns a markdown 404 with discovery links.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
        RateLimited: {
          description:
            "Rate limited; the body includes retryAfterSeconds and the response carries Retry-After",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
    externalDocs: {
      description: "Agent skill and usage guide",
      url: `${BASE_URL}/skill.md`,
    },
  };

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json(spec);
}
