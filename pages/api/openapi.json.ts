import type { NextApiRequest, NextApiResponse } from "next";

const BASE_URL = "https://milk.market";

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Milk Market API",
      version: "2.0.0",
      description:
        "Public and agent-facing endpoints for Milk Market, a permissionless Bitcoin-native marketplace for local food built on Nostr. Programmatic marketplace participation (search, ordering, stall management) is provided by the Model Context Protocol (MCP) server at /api/mcp using JSON-RPC 2.0; the endpoints below cover discovery, feeds, and the MCP entry point.",
      contact: { name: "Milk Market", url: `${BASE_URL}/contact` },
      license: {
        name: "MIT",
        url: "https://github.com/shopstr-eng/milk-market",
      },
    },
    servers: [{ url: BASE_URL }],
    paths: {
      "/api/mcp": {
        post: {
          operationId: "mcpRpc",
          summary: "Model Context Protocol JSON-RPC 2.0 endpoint",
          description:
            "Streamable HTTP MCP endpoint. Send JSON-RPC 2.0 requests to list and call tools (search_products, get_product_details, create_order, etc.). Some read tools are public; purchasing requires a read_write key and account/stall management requires a full_access key.",
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
            "401": { description: "Missing or invalid API key" },
            "429": { description: "Rate limited" },
          },
        },
      },
      "/api/mcp/status": {
        get: {
          operationId: "mcpStatus",
          summary: "MCP server status",
          responses: { "200": { description: "Status payload" } },
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
