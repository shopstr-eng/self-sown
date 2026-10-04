/** @jest-environment node */

// PARITY GUARD — custom-domain ⇄ self-host routing.
//
// proxy.ts routes seller traffic through two parallel blocks that must serve
// the same agent-facing surface: the custom-domain block and routeSelfHost.
// Branches added to one used to be silently forgotten in the other (the
// self-host block served the PLATFORM's static nostr.json on the seller's own
// domain until the well-known routes were unified into SELLER_WELL_KNOWN_ROUTES).
// This suite drives the same probe paths through both modes and asserts
// identical routing outcomes for:
//   - every GEO/agent file in STALL_GEO_DYNAMIC_FORMAT,
//   - every per-seller well-known route in SELLER_WELL_KNOWN_ROUTES,
//   - every platform-passthrough page + static-asset prefix,
//   - homepage / blog-post agent content negotiation and plain HTML renders.
// The lists come from the proxy's own exported tables, so adding a route to a
// shared table automatically probes both blocks — and a route hand-wired into
// only one block (or shadowed by a reordered guard) turns this suite red.
// The DELIBERATE divergences (self-host hides marketplace/discovery pages and
// billing/Connect APIs) are pinned at the bottom so changing them is a
// conscious act.
//
// Next encodes rewrites as the `x-middleware-rewrite` response header and
// request-header overrides as `x-middleware-request-<name>`; classification
// reads those. NEXT_PUBLIC_BASE_URL is captured at module import time, so the
// proxy is re-required inside jest.isolateModules; the SS_SELF_HOST* env vars
// are read per-request, so one loaded module serves both modes.

import { NextRequest } from "next/server";

const HOST = "farm.example";
const SLUG = "green-valley";
const PUBKEY = "ab".repeat(32);

const lookupByHost = jest.fn(async () => ({
  slug: null as string | null,
  pubkey: null as string | null,
}));

jest.mock("@/utils/storefront/host-cache", () => ({
  lookupByHost: () => lookupByHost(),
}));

function loadProxyModule(siteUrl: string): typeof import("@/proxy") {
  process.env.NEXT_PUBLIC_BASE_URL = siteUrl;
  let mod: typeof import("@/proxy") | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require("@/proxy");
  });
  return mod!;
}

// Loaded once at collection time so the exported routing tables can drive
// it.each — a new entry is probed in both modes without touching this file.
const ORIGINAL_BASE_URL = process.env.NEXT_PUBLIC_BASE_URL;
const mod = loadProxyModule("https://self-sown.com");
const {
  STALL_GEO_DYNAMIC_FORMAT,
  SELLER_WELL_KNOWN_ROUTES,
  CUSTOM_DOMAIN_PLATFORM_PASSTHROUGH,
  CUSTOM_DOMAIN_PASSTHROUGH_PREFIXES,
} = mod;

type Outcome =
  | { kind: "rewrite"; target: string }
  | { kind: "redirect"; status: number; location: string | null }
  | { kind: "blocked"; status: number }
  | { kind: "passthrough" };

// Classify a proxy response into the routing decision both blocks should agree
// on. Rewrite-target query params are sorted so the two blocks' param
// construction order can't false-positive.
function classify(res: Response): Outcome {
  const rewrite = res.headers.get("x-middleware-rewrite");
  if (rewrite) {
    const url = new URL(rewrite);
    const params = [...url.searchParams.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    return {
      kind: "rewrite",
      target: params ? `${url.pathname}?${params}` : url.pathname,
    };
  }
  if (res.status >= 300 && res.status < 400) {
    return {
      kind: "redirect",
      status: res.status,
      location: res.headers.get("location"),
    };
  }
  if (res.status >= 400) return { kind: "blocked", status: res.status };
  return { kind: "passthrough" };
}

function rewritePathname(res: Response): string | null {
  const rewrite = res.headers.get("x-middleware-rewrite");
  return rewrite ? new URL(rewrite).pathname : null;
}

function buildRequest(
  path: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(`https://${HOST}${path}`, {
    headers: { host: HOST, ...headers },
  });
}

const SELF_HOST_ENV_KEYS = [
  "SS_SELF_HOST",
  "SS_SELF_HOST_SLUG",
  "SS_SELF_HOST_PUBKEY",
  "MM_SELF_HOST",
  "MM_SELF_HOST_SLUG",
  "MM_SELF_HOST_PUBKEY",
] as const;

describe("custom-domain ⇄ self-host routing parity", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of SELF_HOST_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterAll(() => {
    for (const key of SELF_HOST_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    if (ORIGINAL_BASE_URL === undefined)
      delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = ORIGINAL_BASE_URL;
  });

  beforeEach(() => {
    lookupByHost.mockClear();
    // Default: the custom domain resolves to a configured, entitled seller.
    lookupByHost.mockResolvedValue({ slug: SLUG, pubkey: PUBKEY });
  });

  async function routeCustomDomain(
    path: string,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    return mod.proxy(buildRequest(path, headers));
  }

  async function routeSelfHostMode(
    path: string,
    headers: Record<string, string> = {},
    opts: { withPubkey?: boolean } = {}
  ): Promise<Response> {
    process.env.SS_SELF_HOST = "1";
    process.env.SS_SELF_HOST_SLUG = SLUG;
    if (opts.withPubkey !== false) process.env.SS_SELF_HOST_PUBKEY = PUBKEY;
    try {
      return await mod.proxy(buildRequest(path, headers));
    } finally {
      delete process.env.SS_SELF_HOST;
      delete process.env.SS_SELF_HOST_SLUG;
      delete process.env.SS_SELF_HOST_PUBKEY;
    }
  }

  describe("shared surface — identical routing in both modes", () => {
    it.each(Object.entries(STALL_GEO_DYNAMIC_FORMAT))(
      "GEO/agent file %s rewrites to the same stall-agent-view format in both modes",
      async (path, format) => {
        const cd = await routeCustomDomain(path);
        const sh = await routeSelfHostMode(path);
        expect(classify(sh)).toEqual(classify(cd));
        for (const res of [cd, sh]) {
          expect(rewritePathname(res)).toBe("/api/stall-agent-view");
          expect(res.headers.get("x-middleware-request-x-stall-format")).toBe(
            format
          );
        }
      }
    );

    it.each(
      SELLER_WELL_KNOWN_ROUTES.map((r) => [r.path, r.rewriteTo] as const)
    )(
      "well-known route %s rewrites to %s in both modes",
      async (path, rewriteTo) => {
        const cd = await routeCustomDomain(path);
        const sh = await routeSelfHostMode(path);
        expect(classify(sh)).toEqual(classify(cd));
        expect(rewritePathname(cd)).toBe(rewriteTo);
        expect(rewritePathname(sh)).toBe(rewriteTo);
      }
    );

    it("a needsPubkey well-known route falls through to the platform static copy in both modes when no seller resolves", async () => {
      // Custom domain with no verified seller; self-host with no owner pubkey.
      lookupByHost.mockResolvedValue({ slug: null, pubkey: null });
      for (const route of SELLER_WELL_KNOWN_ROUTES.filter(
        (r) => r.needsPubkey
      )) {
        const cd = await routeCustomDomain(route.path);
        const sh = await routeSelfHostMode(
          route.path,
          {},
          { withPubkey: false }
        );
        expect(classify(cd)).toEqual({ kind: "passthrough" });
        expect(classify(sh)).toEqual({ kind: "passthrough" });
      }
    });

    it.each(CUSTOM_DOMAIN_PLATFORM_PASSTHROUGH)(
      "platform page %s passes through (no rewrite) in both modes",
      async (path) => {
        const cd = await routeCustomDomain(path);
        const sh = await routeSelfHostMode(path);
        expect(classify(cd)).toEqual({ kind: "passthrough" });
        expect(classify(sh)).toEqual({ kind: "passthrough" });
      }
    );

    it.each(
      CUSTOM_DOMAIN_PASSTHROUGH_PREFIXES.map(
        (p) => [p, p.endsWith("/") ? `${p}parity-probe.png` : p] as const
      )
    )(
      "static prefix %s (probe %s) routes identically in both modes",
      async (_prefix, path) => {
        const cd = await routeCustomDomain(path);
        const sh = await routeSelfHostMode(path);
        expect(classify(sh)).toEqual(classify(cd));
      }
    );

    it("homepage agent negotiation rewrites identically in both modes", async () => {
      const cd = await routeCustomDomain("/", { accept: "text/markdown" });
      const sh = await routeSelfHostMode("/", { accept: "text/markdown" });
      expect(classify(sh)).toEqual(classify(cd));
      for (const res of [cd, sh]) {
        expect(rewritePathname(res)).toBe("/api/stall-agent-view");
        expect(res.headers.get("x-middleware-request-x-stall-format")).toBe(
          "md"
        );
      }
    });

    it("blog-post agent negotiation rewrites identically in both modes", async () => {
      const cd = await routeCustomDomain("/blog/harvest-notes", {
        accept: "application/json",
      });
      const sh = await routeSelfHostMode("/blog/harvest-notes", {
        accept: "application/json",
      });
      expect(classify(sh)).toEqual(classify(cd));
      for (const res of [cd, sh]) {
        expect(rewritePathname(res)).toBe("/api/stall-agent-view");
        expect(res.headers.get("x-middleware-request-x-post-slug")).toBe(
          "harvest-notes"
        );
      }
    });

    it.each(["/", "/shop", "/blog/why-local-food"])(
      "HTML page %s rewrites to the same /stall/<slug> target in both modes",
      async (path) => {
        const cd = await routeCustomDomain(path, { accept: "text/html" });
        const sh = await routeSelfHostMode(path, { accept: "text/html" });
        expect(classify(sh)).toEqual(classify(cd));
        expect(rewritePathname(cd)).toBe(
          `/stall/${SLUG}${path === "/" ? "" : path}`
        );
      }
    );

    it.each(["/api/db/fetch-products", "/api/pro/status"])(
      "storefront API %s passes through in both modes",
      async (path) => {
        expect(classify(await routeCustomDomain(path))).toEqual({
          kind: "passthrough",
        });
        expect(classify(await routeSelfHostMode(path))).toEqual({
          kind: "passthrough",
        });
      }
    );
  });

  describe("deliberate divergences (pinned so changing them is a conscious act)", () => {
    it("self-host HIDES platform discovery pages; a custom domain serves them under the stall", async () => {
      const cd = await routeCustomDomain("/marketplace", {
        accept: "text/html",
      });
      expect(classify(cd)).toEqual({
        kind: "rewrite",
        target: `/stall/${SLUG}/marketplace`,
      });
      const sh = await routeSelfHostMode("/marketplace", {
        accept: "text/html",
      });
      expect(classify(sh)).toEqual({
        kind: "redirect",
        status: 307,
        location: `https://${HOST}/`,
      });
    });

    it("both modes REFUSE platform billing APIs — 403 (allowlist) on a custom domain, 404 (hidden) on self-host", async () => {
      expect(
        classify(await routeCustomDomain("/api/pro/create-subscription"))
      ).toEqual({ kind: "blocked", status: 403 });
      expect(
        classify(await routeSelfHostMode("/api/pro/create-subscription"))
      ).toEqual({ kind: "blocked", status: 404 });
    });

    it("self-host refuses Stripe Connect APIs that a custom domain allow-lists", async () => {
      expect(
        classify(await routeCustomDomain("/api/stripe/connect/accounts"))
      ).toEqual({ kind: "passthrough" });
      expect(
        classify(await routeSelfHostMode("/api/stripe/connect/accounts"))
      ).toEqual({ kind: "blocked", status: 404 });
    });

    it("the platform MCP endpoint is custom-domain-blocked but self-host-served", async () => {
      expect(classify(await routeCustomDomain("/api/mcp"))).toEqual({
        kind: "blocked",
        status: 403,
      });
      expect(classify(await routeSelfHostMode("/api/mcp"))).toEqual({
        kind: "passthrough",
      });
    });
  });
});
