/** @jest-environment node */

// A seller's custom-domain storefront reads local stock from /api/inventory to
// show sold-out items. The proxy gates /api/* on custom domains to an
// allow-list, so without a read-only entry that request gets a 403 and the
// storefront silently falls back to stale listing quantities. Writes on the
// same route (deduct/set/restore/sync) must stay blocked there.

import { NextRequest } from "next/server";

const lookupByHost = jest.fn(async () => ({
  slug: "green-valley" as string | null,
  pubkey: "ab".repeat(32) as string | null,
}));

jest.mock("@/utils/storefront/host-cache", () => ({
  lookupByHost: () => lookupByHost(),
}));

function loadProxy(siteUrl: string): typeof import("@/proxy").proxy {
  process.env.NEXT_PUBLIC_BASE_URL = siteUrl;
  let proxyFn: typeof import("@/proxy").proxy | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    proxyFn = require("@/proxy").proxy;
  });
  return proxyFn!;
}

function buildRequest(host: string, path: string, method = "GET"): NextRequest {
  return new NextRequest(`https://${host}${path}`, {
    method,
    headers: { host },
  });
}

describe("custom-domain /api/inventory gate", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_BASE_URL;
  const HOST = "farm.example";

  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = ORIGINAL;
  });

  it.each(["GET", "HEAD"])("lets %s through", async (method) => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(
      buildRequest(HOST, `/api/inventory?productIds=${"a".repeat(64)}`, method)
    );
    expect(res.status).not.toBe(403);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "still blocks %s",
    async (method) => {
      const proxy = loadProxy("https://self-sown.com");
      const res = await proxy(buildRequest(HOST, "/api/inventory", method));
      expect(res.status).toBe(403);
    }
  );

  it("does not open look-alike paths", async () => {
    const proxy = loadProxy("https://self-sown.com");
    for (const path of ["/api/inventory-admin", "/api/inventoryx/anything"]) {
      const res = await proxy(buildRequest(HOST, path));
      expect(res.status).toBe(403);
    }
  });

  it("keeps blocking unrelated platform-only routes", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, "/api/mcp"));
    expect(res.status).toBe(403);
  });
});
