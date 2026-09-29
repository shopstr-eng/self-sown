/** @jest-environment node */

// Agent-readiness documentation contract.
//
// External readiness audits (and the agents themselves) discover our
// conventions from four surfaces: the OpenAPI document, agents.txt, llms.txt,
// and the /developers portal. This suite pins the claims each surface must
// keep making so a future edit can't silently drop them:
//
// 1. openapi.json — x-versioning-policy (Deprecation/Sunset commitment) and
//    x-rate-limit-policy (RFC RateLimit header convention) extensions.
// 2. agents.txt — the deprecation/sunset pointer.
// 3. llms.txt — the developer-portal blurb advertising the policies.
// 4. /developers — the human-readable rate-limits + versioning sections.
// 5. Homepage heading hierarchy — the first heading in DOM order is the hero
//    H1; showcase/carousel content rendering ahead of it must not use heading
//    tags (an H3 before the H1 breaks the outline for agents reading raw HTML).

import handler from "@/pages/api/openapi.json";
import { readFileSync } from "fs";
import { join } from "path";

function loadSpec(): Record<string, any> {
  let payload: any;
  const res = {
    setHeader: jest.fn(),
    status(code: number) {
      expect(code).toBe(200);
      return this;
    },
    json(body: any) {
      payload = body;
      return this;
    },
  };
  handler({} as any, res as any);
  return payload;
}

function readPublic(name: string): string {
  return readFileSync(join(process.cwd(), "public", name), "utf8");
}

describe("openapi.json policy extensions", () => {
  const spec = loadSpec();

  it("keeps the versioning policy with the Deprecation/Sunset commitment", () => {
    const policy = spec["x-versioning-policy"];
    expect(policy).toBeDefined();
    expect(policy.description).toContain("Deprecation");
    expect(policy.description).toContain("Sunset");
    expect(policy.description).toContain("RFC 8594");
    expect(policy.policyUrl).toContain("/developers#versioning");
  });

  it("advertises the rate-limit header convention", () => {
    const policy = spec["x-rate-limit-policy"];
    expect(policy).toBeDefined();
    expect(policy.convention).toContain("RateLimit-Limit");
    expect(policy.convention).toContain("RateLimit-Remaining");
    expect(policy.convention).toContain("Retry-After");
    expect(policy.convention).toContain("429");
    // The claims must stay qualified: up-front rejections (e.g. an
    // unsupported API-Version pin) only MAY omit numeric headers (the /api/mcp
    // advisory still stamps its 400s), and agents.txt publishes MCP budgets
    // only — other endpoints self-declare in their response headers.
    expect(policy.convention).toContain("may omit numeric headers");
    expect(policy.convention).toContain(
      "MCP budgets are published in agents.txt"
    );
    expect(policy.convention).toContain(
      "declares its own budget in its response headers"
    );
    expect(policy.documentationUrl).toContain("/developers#rate-limits");
  });
});

describe("static discovery files", () => {
  it("agents.txt points agents at the deprecation/sunset policy", () => {
    const agents = readPublic("agents.txt");
    expect(agents).toContain("Deprecation");
    expect(agents).toContain("Sunset");
    expect(agents).toContain("RFC 8594");
    expect(agents).toContain("/developers#versioning");
    expect(agents).toContain("RateLimit-Limit");
  });

  it("agents.txt lists every MCP budget the OpenAPI extension points to", () => {
    const agents = readPublic("agents.txt");
    expect(agents).toContain("600 requests/minute per IP");
    expect(agents).toContain("300 requests/minute per API key");
    expect(agents).toContain("30 requests/minute per IP for unauthenticated");
    // ...and directs agents to per-response headers for everything else.
    expect(agents).toContain("declare their own budgets in their RateLimit-*");
  });

  it("llms.txt advertises the developer portal with its policies", () => {
    const llms = readPublic("llms.txt");
    const portalLine = llms
      .split("\n")
      .find((line) => line.includes("/developers"));
    expect(portalLine).toBeDefined();
    expect(portalLine).toContain("rate-limit");
    expect(portalLine).toContain("deprecation");
  });
});

describe("/developers portal", () => {
  const src = readFileSync(
    join(process.cwd(), "pages/developers/index.tsx"),
    "utf8"
  );

  it("has an anchored rate-limits section the OpenAPI extension links to", () => {
    expect(src).toContain('id="rate-limits"');
    expect(src).toContain("RateLimit-Limit");
    expect(src).toContain("Retry-After");
  });

  it("keeps the anchored versioning/deprecation section", () => {
    expect(src).toContain('id="versioning"');
    expect(src).toContain("Deprecation");
    expect(src).toContain("Sunset");
  });

  it("names the deprecation policy in the meta description", () => {
    expect(src).toMatch(/content="[^"]*deprecation/);
  });
});

describe("homepage heading hierarchy", () => {
  const src = readFileSync(join(process.cwd(), "pages/index.tsx"), "utf8");

  // Extract a top-level `function Name() { ... }` body (closes at the first
  // column-0 `}`), so assertions stay scoped to the component.
  function componentBody(name: string): string {
    const start = src.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`${name} not found in pages/index.tsx`);
    const end = src.indexOf("\n}", start);
    if (end === -1) throw new Error(`${name} body not terminated`);
    return src.slice(start, end);
  }

  it("has exactly one H1 (the hero)", () => {
    expect(src.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  it("renders no heading tags in the showcase/carousel slide content", () => {
    // Slide/card content is not document structure; headings there break the
    // outline wherever the carousel lands.
    expect(componentBody("YourStallSlide")).not.toMatch(/<h[1-6][\s>]/);
    expect(componentBody("YouTubeCarousel")).not.toMatch(/<h[1-6][\s>]/);
  });

  it("never skips a heading level in the page body (hero H1 through footer)", () => {
    // Helper components are defined above the default export, so slicing from
    // it onward scans the page body in render order.
    const bodyStart = src.indexOf("export default function");
    if (bodyStart === -1) throw new Error("default export not found");
    const levels = [...src.slice(bodyStart).matchAll(/<h([1-6])[\s>]/g)].map(
      (m) => Number(m[1])
    );
    expect(levels.length).toBeGreaterThan(3);
    const [hero, ...rest] = levels;
    expect(hero).toBe(1); // the hero H1 leads the page
    let prev = hero ?? 1;
    for (const curr of rest) {
      // Deeper nesting is fine one level at a time; jumping back out to any
      // shallower level is fine. Skipping a level going deeper is not.
      expect(curr).toBeLessThanOrEqual(prev + 1);
      prev = curr;
    }
  });
});

describe("scoped API permissions", () => {
  const spec = loadSpec();

  it("declares the audience scopes on the bearerAuth security scheme", () => {
    const scopes = spec.components.securitySchemes.bearerAuth["x-scopes"];
    expect(Object.keys(scopes).sort()).toEqual(["seller", "shopping"]);
    for (const description of Object.values(scopes)) {
      expect(typeof description).toBe("string");
      expect((description as string).length).toBeGreaterThan(10);
    }
  });

  it("agents.txt + llms.txt point at the RFC 9728 scope metadata", () => {
    expect(readPublic("agents.txt")).toContain(
      "/.well-known/oauth-protected-resource"
    );
    expect(readPublic("llms.txt")).toContain("oauth-protected-resource");
  });
});

describe("documented pagination shape", () => {
  const spec = loadSpec();

  it("states the pagination convention", () => {
    expect(spec["x-pagination"].convention).toContain("limit");
    expect(spec["x-pagination"].convention).toContain("offset");
    expect(spec["x-pagination"].convention).toContain("hasMore");
  });

  it("defines the pagination fields in the UCP search response schema", () => {
    const context =
      spec.paths["/api/ucp/catalog/search"].get.responses["200"].content[
        "application/json"
      ].schema.properties.context.properties;
    // The schema must mirror the handler's actual response: pagination is a
    // nested object (not flat context fields).
    expect(context.pagination).toBeDefined();
    expect(Object.keys(context.pagination.properties).sort()).toEqual([
      "hasMore",
      "limit",
      "nextCursor",
      "offset",
      "returned",
      "total",
    ]);
    expect(context.pagination.required).toContain("hasMore");
  });

  it("documents the same contract on the checkout-sessions list", () => {
    const get = spec.paths["/api/ucp/checkout/sessions"].get;
    const schema = get.responses["200"].content["application/json"].schema;
    // An object envelope (sessions + context), never a bare array.
    expect(schema.required).toContain("sessions");
    expect(schema.required).toContain("context");
    const pagination = schema.properties.context.properties.pagination;
    expect(Object.keys(pagination.properties).sort()).toEqual([
      "hasMore",
      "limit",
      "nextCursor",
      "offset",
      "returned",
    ]);
    expect(pagination.required).toContain("hasMore");
    expect(get.parameters.map((p: any) => p.name)).toEqual(
      expect.arrayContaining(["limit", "offset", "cursor"])
    );
  });
});

describe("JSON-LD breadth", () => {
  const src = readFileSync(
    join(process.cwd(), "components/structured-data.tsx"),
    "utf8"
  );

  it("Organization schema carries sameAs disambiguation links", () => {
    expect(src).toContain('"https://github.com/shopstr-eng"');
    expect(src).toContain("njump.me");
  });

  it("publishes pricing as schema.org Offer structured data", () => {
    expect(src).toContain('"@type": "Service"');
    expect(src).toContain('"@type": "Offer"');
    // Prices must come from the shared constants, not literals that drift.
    expect(src).toContain("PRO_MONTHLY_PRICE_CENTS");
    expect(src).toContain("WRANGLER_LIFETIME_PRICE_CENTS");
  });
});
