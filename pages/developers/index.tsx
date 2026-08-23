import { useRouter } from "next/router";
import Head from "next/head";
import Link from "next/link";
import { WHITEBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";

// Developer/agent portal: the one human-readable page that ties together every
// machine-readable surface (MCP, UCP, OpenAPI, discovery documents) plus the
// error-model and versioning contracts agents can rely on. Keep claims here
// consistent with public/llms.txt and public/.well-known/*.

const INIT_CURL = `curl -X POST https://milk.market/api/mcp \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "my-agent", "version": "0.1.0" }
    }
  }'`;

const TOOLS_LIST_CURL = `curl -X POST https://milk.market/api/mcp \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -H "mcp-session-id: <session id from the initialize response>" \\
  -d '{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }'`;

const ERROR_EXAMPLE = `{
  "error": "Not found",
  "code": "not_found",
  "status": 404,
  "documentation": {
    "openapi": "https://milk.market/openapi.json",
    "mcp": "https://milk.market/.well-known/mcp.json",
    "agents": "https://milk.market/agents.txt"
  }
}`;

const MACHINE_READABLE: { href: string; label: string; blurb: string }[] = [
  {
    href: "/openapi.json",
    label: "openapi.json",
    blurb: "OpenAPI 3.1 document covering every public endpoint.",
  },
  {
    href: "/.well-known/mcp.json",
    label: ".well-known/mcp.json",
    blurb: "MCP discovery document (streamable HTTP JSON-RPC 2.0).",
  },
  {
    href: "/agents.txt",
    label: "agents.txt",
    blurb: "Allowed actions, rate limits, and access rules for agents.",
  },
  {
    href: "/skill.md",
    label: "skill.md",
    blurb: "Agent skill: how an agent should drive Milk Market.",
  },
  {
    href: "/llms.txt",
    label: "llms.txt",
    blurb: "Concise site index for language models.",
  },
  {
    href: "/llms-full.txt",
    label: "llms-full.txt",
    blurb: "Expanded plain-text description of the whole platform.",
  },
  {
    href: "/.well-known/agent-card.json",
    label: "agent-card.json",
    blurb: "Google A2A agent card describing capabilities.",
  },
  {
    href: "/.well-known/ucp",
    label: ".well-known/ucp",
    blurb:
      "Universal Commerce Protocol profile (REST catalog + checkout sessions).",
  },
  {
    href: "/.well-known/l402.json",
    label: "l402.json",
    blurb: "Facilitator-agnostic L402 (HTTP 402) pay-per-request standard.",
  },
  {
    href: "/.well-known/http-message-signatures-directory",
    label: "http-message-signatures-directory",
    blurb: "Ed25519 JWK Set for verifying Web Bot Auth message signatures.",
  },
  {
    href: "/rss.xml",
    label: "rss.xml",
    blurb: "Recent product listings as an RSS 2.0 feed.",
  },
  {
    href: "/sitemap.xml",
    label: "sitemap.xml",
    blurb: "XML sitemap of primary pages.",
  },
];

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="shadow-neo mt-4 overflow-x-auto rounded-lg border-2 border-black bg-zinc-900 p-4 text-sm text-zinc-100">
      <code>{children}</code>
    </pre>
  );
}

export default function Developers() {
  const router = useRouter();

  return (
    <>
      <Head>
        <title>Developers & AI Agents | Milk Market</title>
        <meta
          name="description"
          content="Build on Milk Market: MCP server for AI agents, UCP REST catalog and checkout, OpenAPI reference, error model, and versioning policy."
        />
      </Head>
      <div className="bg-grid-pattern flex min-h-screen flex-col bg-white py-8 md:pb-20">
        <div className="container mx-auto max-w-4xl px-4">
          <div className="mb-12">
            <button
              onClick={() => router.back()}
              className={`${WHITEBUTTONCLASSNAMES} mb-8 flex items-center gap-2`}
            >
              <span aria-hidden="true" className="text-sm leading-none">
                ⬅️
              </span>
              Back
            </button>
            <h1 className="text-center text-5xl font-bold text-black">
              Developers & AI Agents
            </h1>
            <p className="mt-4 text-center text-lg text-zinc-600">
              Milk Market is built to be operated by machines: search the
              catalog, place orders, and run a stall through documented,
              machine-readable interfaces.
            </p>
          </div>

          {/* Quickstart */}
          <div className="mb-12">
            <h2 className="mb-6 text-2xl font-bold text-black">Quickstart</h2>
            <div className="shadow-neo rounded-lg border-2 border-black bg-white p-6">
              <p className="text-zinc-700">
                The fastest way in is the Model Context Protocol server at{" "}
                <code className="rounded bg-zinc-100 px-1">/api/mcp</code>. The{" "}
                <code className="rounded bg-zinc-100 px-1">initialize</code>{" "}
                handshake, tool listing, and the public read tools (product
                search and details) work without an API key:
              </p>
              <CodeBlock>{INIT_CURL}</CodeBlock>
              <p className="mt-4 text-zinc-700">
                The response carries an{" "}
                <code className="rounded bg-zinc-100 px-1">mcp-session-id</code>{" "}
                header. Send it back on every follow-up request:
              </p>
              <CodeBlock>{TOOLS_LIST_CURL}</CodeBlock>
              <p className="mt-4 text-zinc-700">
                To buy, manage orders, or administer a stall, create an API key
                under <em>Settings → API keys</em> and send it as{" "}
                <code className="rounded bg-zinc-100 px-1">
                  Authorization: Bearer sk_…
                </code>
                . Keys come in three scopes: <strong>read</strong>,{" "}
                <strong>read_write</strong> (adds purchasing), and{" "}
                <strong>full_access</strong> (adds stall/account management).
              </p>
            </div>
          </div>

          {/* UCP */}
          <div className="mb-12">
            <h2 className="mb-6 text-2xl font-bold text-black">
              REST alternative: UCP
            </h2>
            <div className="shadow-neo rounded-lg border-2 border-black bg-white p-6">
              <p className="text-zinc-700">
                Prefer plain REST? The Universal Commerce Protocol endpoints
                expose the same catalog and order pipeline:{" "}
                <code className="rounded bg-zinc-100 px-1">
                  GET /api/ucp/catalog/search
                </code>{" "}
                and{" "}
                <code className="rounded bg-zinc-100 px-1">
                  GET /api/ucp/catalog/lookup
                </code>{" "}
                read products, and{" "}
                <code className="rounded bg-zinc-100 px-1">
                  POST /api/ucp/checkout/sessions
                </code>{" "}
                places an order (requires a read_write key). Response shapes are
                published as JSON Schema at{" "}
                <code className="rounded bg-zinc-100 px-1">
                  /api/ucp/schemas/product.json
                </code>{" "}
                and{" "}
                <code className="rounded bg-zinc-100 px-1">
                  /api/ucp/schemas/checkout-session.json
                </code>
                , and referenced from the OpenAPI document.
              </p>
            </div>
          </div>

          {/* Machine-readable surfaces */}
          <div className="mb-12">
            <h2 className="mb-6 text-2xl font-bold text-black">
              Machine-readable surfaces
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {MACHINE_READABLE.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="shadow-neo block rounded-lg border-2 border-black bg-white p-4 transition-transform hover:-translate-y-0.5"
                >
                  <div className="font-mono text-sm font-bold text-black">
                    {item.label}
                  </div>
                  <div className="mt-1 text-sm text-zinc-600">{item.blurb}</div>
                </Link>
              ))}
            </div>
            <p className="mt-4 text-sm text-zinc-600">
              Seller custom domains and self-hosted instances serve the same
              discovery documents and honor the same content negotiation, so an
              agent can treat any Milk Market storefront as a first-class
              endpoint.
            </p>
          </div>

          {/* Error model */}
          <div className="mb-12">
            <h2 className="mb-6 text-2xl font-bold text-black">Error model</h2>
            <div className="shadow-neo rounded-lg border-2 border-black bg-white p-6">
              <p className="text-zinc-700">
                Every error response carries a human-readable{" "}
                <code className="rounded bg-zinc-100 px-1">error</code> string.
                Agent-facing endpoints add a stable machine-readable{" "}
                <code className="rounded bg-zinc-100 px-1">code</code> plus
                discovery links — branch on{" "}
                <code className="rounded bg-zinc-100 px-1">code</code>, never on
                prose. Rate limiting returns 429 with{" "}
                <code className="rounded bg-zinc-100 px-1">
                  retryAfterSeconds
                </code>{" "}
                in the body and a{" "}
                <code className="rounded bg-zinc-100 px-1">Retry-After</code>{" "}
                header. The MCP endpoint speaks JSON-RPC 2.0, so its errors
                arrive in the JSON-RPC error envelope (
                <code className="rounded bg-zinc-100 px-1">error.code</code> /{" "}
                <code className="rounded bg-zinc-100 px-1">error.message</code>)
                instead of this REST shape.
              </p>
              <CodeBlock>{ERROR_EXAMPLE}</CodeBlock>
              <p className="mt-4 text-zinc-700">
                Unknown routes are content-negotiated: send{" "}
                <code className="rounded bg-zinc-100 px-1">
                  Accept: text/markdown
                </code>{" "}
                and a 404 comes back as markdown with links to the documents
                above; otherwise it comes back as the JSON shape shown here.
              </p>
            </div>
          </div>

          {/* Versioning policy */}
          <div className="mb-12" id="versioning">
            <h2 className="mb-6 text-2xl font-bold text-black">
              Versioning policy
            </h2>
            <div className="shadow-neo rounded-lg border-2 border-black bg-white p-6">
              <ul className="list-disc space-y-2 pl-5 text-zinc-700">
                <li>
                  The OpenAPI document is semantically versioned (current: 2.x,
                  see{" "}
                  <code className="rounded bg-zinc-100 px-1">
                    info.version
                  </code>{" "}
                  and{" "}
                  <code className="rounded bg-zinc-100 px-1">
                    x-versioning-policy
                  </code>
                  ).
                </li>
                <li>
                  Additive changes — new endpoints, new optional fields, new
                  enum values — can ship at any time. Clients must ignore
                  unknown fields.
                </li>
                <li>
                  Breaking changes — removed or renamed fields or endpoints,
                  newly required parameters — ship only in a new major version.
                </li>
                <li>
                  Deprecated operations carry the{" "}
                  <code className="rounded bg-zinc-100 px-1">Deprecation</code>{" "}
                  response header and, once a removal date is set, the{" "}
                  <code className="rounded bg-zinc-100 px-1">Sunset</code>{" "}
                  header (RFC 8594), at least 90 days before removal.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
