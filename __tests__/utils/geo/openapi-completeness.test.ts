/** @jest-environment node */

// Spec-lint for the public OpenAPI document (pages/api/openapi.json.ts).
// These are the agent-readiness contracts an external auditor checks: every
// operation is self-describing (operationId + summary + description), the
// typed error model is referenced consistently, response-schema coverage
// stays above the function-calling threshold, every parameter is typed, and
// the API-Version header parameter exists.

import handler from "@/pages/api/openapi.json";

function loadSpec(): any {
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
  } as any;
  handler({} as any, res);
  return payload;
}

const spec = loadSpec();
const HTTP_METHODS = ["get", "post", "put", "delete", "patch"];

type Op = { path: string; method: string; op: any };

function operations(): Op[] {
  const ops: Op[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    for (const method of HTTP_METHODS) {
      if (item[method]) ops.push({ path, method, op: item[method] });
    }
  }
  return ops;
}

describe("openapi.json — agent-readiness contract", () => {
  const ops = operations();

  it("declares the same version in info and the versioning policy", () => {
    expect(spec.info.version).toBe(spec["x-versioning-policy"].current);
  });

  it("every operation has operationId, summary, and a non-empty description", () => {
    for (const { path, method, op } of ops) {
      expect(typeof op.operationId).toBe("string");
      expect(typeof op.summary).toBe("string");
      expect({ at: `${method} ${path}`, len: op.description?.length }).toEqual({
        at: `${method} ${path}`,
        len: expect.any(Number),
      });
      expect(op.description.length).toBeGreaterThan(0);
    }
  });

  it("operationIds are unique", () => {
    const ids = ops.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every operation references the shared typed error model", () => {
    for (const { path, method, op } of ops) {
      const hasSharedErrorRef = Object.entries<any>(op.responses).some(
        ([code, r]) =>
          code.startsWith("4") &&
          typeof r?.$ref === "string" &&
          r.$ref.startsWith("#/components/responses/")
      );
      expect({ at: `${method} ${path}`, hasSharedErrorRef }).toEqual({
        at: `${method} ${path}`,
        hasSharedErrorRef: true,
      });
    }
  });

  it("every shared error response resolves to a typed error schema", () => {
    for (const [name, r] of Object.entries<any>(spec.components.responses)) {
      const ref = r?.content?.["application/json"]?.schema?.$ref;
      expect({ name, ref }).toEqual({
        name,
        ref: expect.stringMatching(
          /^#\/components\/schemas\/(Error|JsonRpcError)$/
        ),
      });
    }
  });

  it("at least 60% of operations return typed response schemas", () => {
    const typed = ops.filter(({ op }) =>
      Object.values<any>(op.responses).some((r) =>
        Object.values<any>(r?.content ?? {}).some((c) => {
          const s = c?.schema;
          if (!s) return false;
          if (typeof s.$ref === "string") return true;
          return typeof s.type === "string" || Array.isArray(s.type);
        })
      )
    );
    expect(typed.length / ops.length).toBeGreaterThanOrEqual(0.6);
  });

  it("every parameter is typed", () => {
    for (const { path, method, op } of ops) {
      for (const p of op.parameters ?? []) {
        if (p.$ref) continue; // shared component params are typed at the component
        expect({
          at: `${method} ${path}`,
          param: p.name,
          type: p.schema?.type,
        }).toEqual({
          at: `${method} ${path}`,
          param: p.name,
          type: expect.any(String),
        });
      }
    }
  });

  it("documents the API-Version header parameter", () => {
    const p = spec.components?.parameters?.ApiVersion;
    expect(p?.in).toBe("header");
    expect(p?.name).toBe("API-Version");
    expect(p?.schema?.enum).toContain("2");
  });

  it("keeps the condensed UCP checkout-session status enum in sync with the lifecycle", () => {
    const session = spec.components.schemas.UcpCheckoutSession;
    expect(session.properties.status.enum).toEqual([
      "incomplete",
      "ready_for_complete",
      "complete_in_progress",
      "completed",
      "requires_escalation",
      "canceled",
    ]);
  });
});
