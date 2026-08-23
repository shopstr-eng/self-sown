import type { NextApiRequest, NextApiResponse } from "next";

const BASE_URL = "https://milk.market";

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Milk Market API",
      version: "2.1.0",
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
      current: "2.1.0",
      description:
        "This document is semantically versioned. Breaking changes (removed or renamed fields/endpoints, newly required parameters) ship only in a new major version. Additive changes (new endpoints, new optional fields, new enum values) can ship at any time — clients MUST ignore unknown fields. Deprecated operations carry the Deprecation response header and, once a removal date is set, the Sunset header (RFC 8594), at least 90 days before removal.",
      policyUrl: `${BASE_URL}/developers#versioning`,
    },
    paths: {
      "/api/mcp": {
        post: {
          operationId: "mcpRpc",
          summary: "Model Context Protocol JSON-RPC 2.0 endpoint",
          description:
            "Streamable HTTP MCP endpoint. Send JSON-RPC 2.0 requests to list and call tools (search_products, get_product_details, create_order, etc.). The initialize handshake, tools/list, resources/list, and the public read tools work WITHOUT an API key (a presented-but-invalid key is rejected with 401); purchasing requires a read_write key and account/stall management requires a full_access key. Unauthenticated initialize is capped at 30 requests/minute and 5 concurrent sessions per IP; all 429 responses (global, per-key, anonymous-initialize, and the concurrent-session cap) use the shared RateLimited body.",
          security: [{ bearerAuth: [] }, {}],
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
              description: "JSON-RPC result or SSE stream",
              content: { "application/json": { schema: { type: "object" } } },
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
          responses: {
            "200": {
              description: "RSS feed",
              content: { "application/rss+xml": {} },
            },
          },
        },
      },
      "/sitemap.xml": {
        get: {
          operationId: "sitemap",
          summary: "XML sitemap",
          responses: {
            "200": {
              description: "Sitemap",
              content: { "application/xml": {} },
            },
          },
        },
      },
      "/llms.txt": {
        get: {
          operationId: "llmsTxt",
          summary: "Plain-text site description for LLMs",
          responses: {
            "200": {
              description: "llms.txt",
              content: { "text/markdown": {} },
            },
          },
        },
      },
      "/.well-known/mcp.json": {
        get: {
          operationId: "mcpDiscovery",
          summary: "MCP discovery document",
          responses: {
            "200": {
              description: "MCP discovery JSON",
              content: { "application/json": {} },
            },
          },
        },
      },
      "/.well-known/agent-card.json": {
        get: {
          operationId: "agentCard",
          summary: "Google A2A agent card",
          responses: {
            "200": {
              description: "Agent card JSON",
              content: { "application/json": {} },
            },
          },
        },
      },
      "/.well-known/l402.json": {
        get: {
          operationId: "l402Discovery",
          summary:
            "L402 discovery document (facilitator-agnostic HTTP 402 payments)",
          responses: {
            "200": {
              description: "L402 discovery JSON",
              content: { "application/json": {} },
            },
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
              content: { "application/json": {} },
            },
          },
        },
      },
      "/api/ucp/catalog/search": {
        get: {
          operationId: "ucpCatalogSearch",
          summary: "UCP catalog search",
          description:
            "Search products (host-scoped to one seller on a seller domain). Supports q, category, availability, location, limit, offset.",
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
                          $ref: `${BASE_URL}/api/ucp/schemas/product.json`,
                        },
                      },
                      context: {
                        type: "object",
                        description:
                          "Echo of the resolved scope and query filters, plus pagination (total, limit, offset).",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/ucp/catalog/lookup": {
        get: {
          operationId: "ucpCatalogLookup",
          summary: "UCP product lookup",
          description:
            "Look up a single product by id, d-tag, or slug, with live inventory + accepted payment methods.",
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
                        $ref: `${BASE_URL}/api/ucp/schemas/product.json`,
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
          responses: {
            "200": {
              description:
                "Checkout session in a 'requires_escalation' state (a recoverable problem the buyer/seller must resolve out of band)",
              content: {
                "application/json": {
                  schema: {
                    $ref: `${BASE_URL}/api/ucp/schemas/checkout-session.json`,
                  },
                },
              },
            },
            "201": {
              description: "Checkout session created",
              content: {
                "application/json": {
                  schema: {
                    $ref: `${BASE_URL}/api/ucp/schemas/checkout-session.json`,
                  },
                },
              },
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
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Checkout sessions",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      $ref: `${BASE_URL}/api/ucp/schemas/checkout-session.json`,
                    },
                  },
                },
              },
            },
            "401": { $ref: "#/components/responses/Unauthorized" },
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
                    $ref: `${BASE_URL}/api/ucp/schemas/checkout-session.json`,
                  },
                },
              },
            },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "404": {
              $ref: "#/components/responses/NotFound",
              description: "Checkout session not found",
            },
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
                    $ref: `${BASE_URL}/api/ucp/schemas/checkout-session.json`,
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
          responses: {
            "200": {
              description: "JSON Schema (draft 2020-12)",
              content: { "application/json": {} },
            },
          },
        },
      },
      "/api/ucp/schemas/checkout-session.json": {
        get: {
          operationId: "ucpCheckoutSessionSchema",
          summary: "JSON Schema for the UCP checkout session shape",
          responses: {
            "200": {
              description: "JSON Schema (draft 2020-12)",
              content: { "application/json": {} },
            },
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
