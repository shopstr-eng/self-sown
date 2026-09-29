/** @jest-environment node */

// RFC 9728 protected-resource metadata: agents read scopes_supported here to
// request least-privilege API keys. The declared scopes must stay in lockstep
// with the OpenAPI bearerAuth x-scopes extension (pinned in
// agent-readiness-docs.test.ts).

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

import handler from "@/pages/api/.well-known/oauth-protected-resource";
import openapiHandler from "@/pages/api/openapi.json";
import { SITE_URL } from "@/utils/site-url";
import { readFileSync } from "fs";
import { join } from "path";
import type { NextApiRequest, NextApiResponse } from "next";

function loadSpec(): Record<string, any> {
  let payload: any;
  const res = {
    setHeader: jest.fn(),
    status() {
      return this;
    },
    json(body: any) {
      payload = body;
      return this;
    },
  };
  openapiHandler({} as any, res as any);
  return payload;
}

function invoke(method: string): {
  status: number | null;
  body: any;
  headers: Record<string, string>;
} {
  const out = {
    status: null as number | null,
    body: null as any,
    headers: {} as Record<string, string>,
  };
  const res = {
    setHeader(name: string, value: string) {
      out.headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      out.status = code;
      return this;
    },
    json(payload: any) {
      out.body = payload;
      return this;
    },
  };
  return (async () => {
    await handler(
      { method, headers: {} } as NextApiRequest,
      res as unknown as NextApiResponse
    );
    return out;
  })() as any;
}

describe("/.well-known/oauth-protected-resource", () => {
  it("serves RFC 9728 metadata with the declared scopes", async () => {
    const out = await invoke("GET");
    expect(out.status).toBe(200);
    // RFC 9728 §3.3: the root well-known URL is only valid for a resource
    // identifier WITHOUT a path — the origin itself.
    expect(out.body.resource).toBe(SITE_URL);
    expect(new URL(out.body.resource).pathname).toBe("/");
    expect(out.body.scopes_supported).toEqual([
      "read",
      "read_write",
      "full_access",
    ]);
    expect(out.body.bearer_methods_supported).toEqual(["header"]);
    expect(out.body.resource_documentation).toContain("/developers");
    expect(out.headers["cache-control"]).toContain("public");
  });

  it("rejects non-GET methods with 405", async () => {
    const out = await invoke("POST");
    expect(out.status).toBe(405);
    expect(out.headers["allow"]).toBe("GET, HEAD");
  });

  it("declares the SAME scopes on every machine-readable surface", async () => {
    const out = await invoke("GET");
    const spec = loadSpec();
    const xScopes = Object.keys(
      spec.components.securitySchemes.bearerAuth["x-scopes"]
    ).sort();
    expect([...out.body.scopes_supported].sort()).toEqual(xScopes);
    const agents = readFileSync(
      join(process.cwd(), "public", "agents.txt"),
      "utf8"
    );
    for (const scope of out.body.scopes_supported) {
      expect(agents).toContain(scope);
    }
  });
});
