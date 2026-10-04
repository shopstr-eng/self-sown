/** @jest-environment node */

// Self-host (single-tenant) rewrites must stamp the owner's identity into the
// x-ss-shop-pubkey request header so SSR renders the shop knowing who it
// belongs to. selfHostPubkeyHex() accepts an npub or 64-char hex from
// SS_SELF_HOST_PUBKEY (legacy: MM_SELF_HOST_PUBKEY) and SILENTLY omits the
// header for anything malformed — a fail-safe, but one no test pinned: a
// regression that stops parsing valid values would boot every self-hosted
// shop without its owner identity, and a regression that passes malformed
// values through would seed SSR with a bogus pubkey. This suite locks both
// directions on every routeSelfHost branch that bears the header.
//
// SS_SELF_HOST / SS_SELF_HOST_SLUG / SS_SELF_HOST_PUBKEY are read per-request,
// but NEXT_PUBLIC_BASE_URL is captured at module import time, so the env vars
// are stubbed and proxy re-required inside jest.isolateModules.
//
// Next encodes request-header overrides on the response as
// `x-middleware-request-<name>` entries, so the tests assert on those.

import { NextRequest } from "next/server";
import { nip19 } from "nostr-tools";

// Self-host mode never hits the per-host lookup (slug/pubkey come from the
// environment), but the import chain pulls the cache module in — mock it so
// the suite never touches a DB pool.
jest.mock("@/utils/storefront/host-cache", () => ({
  lookupByHost: jest.fn(async () => ({ slug: null, pubkey: null })),
}));

const SELF_HOST_ENV = [
  "SS_SELF_HOST",
  "SS_SELF_HOST_SLUG",
  "SS_SELF_HOST_PUBKEY",
  "MM_SELF_HOST_PUBKEY",
] as const;

function loadProxy(siteUrl: string): typeof import("@/proxy").proxy {
  process.env.NEXT_PUBLIC_BASE_URL = siteUrl;
  let proxyFn: typeof import("@/proxy").proxy | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    proxyFn = require("@/proxy").proxy;
  });
  return proxyFn!;
}

function buildRequest(
  host: string,
  path: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(`https://${host}${path}`, {
    headers: { host, ...headers },
  });
}

const PUBKEY_OVERRIDE = "x-middleware-request-x-ss-shop-pubkey";

function shopPubkey(res: Response): string | null {
  return res.headers.get(PUBKEY_OVERRIDE);
}

// One representative request per routeSelfHost branch that stamps headers via
// buildHeaders: stall rewrite, content-negotiated agent-view rewrite,
// per-stall GEO file rewrite, well-known rewrite, platform-page passthrough,
// allowed-API passthrough, and already-prefixed stall passthrough. (The
// static-asset passthrough and the hidden-page redirect never stamp headers.)
const HEADER_BRANCHES: Array<{
  name: string;
  path: string;
  headers?: Record<string, string>;
}> = [
  { name: "stall rewrite", path: "/shop", headers: { accept: "text/html" } },
  {
    name: "agent-view rewrite",
    path: "/",
    headers: { accept: "text/markdown" },
  },
  { name: "GEO file rewrite", path: "/llms.txt" },
  { name: "well-known rewrite", path: "/.well-known/nostr.json" },
  { name: "platform-page passthrough", path: "/cart" },
  { name: "API passthrough", path: "/api/db/fetch-products" },
];

describe("self-host rewrites stamp x-ss-shop-pubkey", () => {
  const ORIGINAL_ENV: Record<string, string | undefined> = {};
  const HOST = "shop.myownfarm.test";
  const SLUG = "green-valley";
  const PUBKEY = "ab".repeat(32);
  const NPUB = nip19.npubEncode(PUBKEY);

  beforeEach(() => {
    for (const key of [...SELF_HOST_ENV, "NEXT_PUBLIC_BASE_URL"]) {
      ORIGINAL_ENV[key] = process.env[key];
    }
    process.env.SS_SELF_HOST = "1";
    process.env.SS_SELF_HOST_SLUG = SLUG;
    process.env.SS_SELF_HOST_PUBKEY = PUBKEY;
    delete process.env.MM_SELF_HOST_PUBKEY;
  });

  afterEach(() => {
    for (const key of Object.keys(ORIGINAL_ENV)) {
      if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL_ENV[key];
    }
  });

  it.each(HEADER_BRANCHES)(
    "valid hex env reaches x-ss-shop-pubkey on the $name branch",
    async ({ path, headers }) => {
      const proxy = loadProxy("https://self-sown.com");
      const res = await proxy(buildRequest(HOST, path, headers));
      expect(shopPubkey(res)).toBe(PUBKEY);
    }
  );

  it("already-prefixed /stall/<slug> passthrough stamps the pubkey", async () => {
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, `/stall/${SLUG}/shop`));
    expect(shopPubkey(res)).toBe(PUBKEY);
  });

  it("uppercase hex is normalized to lowercase", async () => {
    process.env.SS_SELF_HOST_PUBKEY = PUBKEY.toUpperCase();
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, "/shop"));
    expect(shopPubkey(res)).toBe(PUBKEY);
  });

  it.each(HEADER_BRANCHES)(
    "valid npub env decodes to lowercase hex on the $name branch",
    async ({ path, headers }) => {
      process.env.SS_SELF_HOST_PUBKEY = NPUB;
      const proxy = loadProxy("https://self-sown.com");
      const res = await proxy(buildRequest(HOST, path, headers));
      expect(shopPubkey(res)).toBe(PUBKEY);
    }
  );

  it("legacy MM_SELF_HOST_PUBKEY is honored when SS_SELF_HOST_PUBKEY is unset", async () => {
    delete process.env.SS_SELF_HOST_PUBKEY;
    process.env.MM_SELF_HOST_PUBKEY = PUBKEY;
    const proxy = loadProxy("https://self-sown.com");
    const res = await proxy(buildRequest(HOST, "/shop"));
    expect(shopPubkey(res)).toBe(PUBKEY);
  });

  describe("malformed env omits the header (fail-safe, never bogus)", () => {
    const MALFORMED = [
      "not-a-pubkey",
      "ab".repeat(31), // 62 chars — too short
      "ab".repeat(33), // 66 chars — too long
      "zz".repeat(32), // 64 chars but not hex
      "npub1invalid0", // npub prefix but undecodable
      nip19.npubEncode("cd".repeat(32)).slice(0, -1) + "x", // bad checksum
    ];

    it.each(MALFORMED)(
      "omits x-ss-shop-pubkey on every branch for %s",
      async (value) => {
        process.env.SS_SELF_HOST_PUBKEY = value;
        const proxy = loadProxy("https://self-sown.com");
        for (const { path, headers } of [
          ...HEADER_BRANCHES,
          { name: "prefixed stall", path: `/stall/${SLUG}/shop` },
        ]) {
          const res = await proxy(buildRequest(HOST, path, headers));
          expect(shopPubkey(res)).toBeNull();
        }
      }
    );

    it("a malformed SS value does not fall back to a valid MM value", async () => {
      // ?? is not validity-aware: a present-but-malformed SS_SELF_HOST_PUBKEY
      // wins over MM_SELF_HOST_PUBKEY, and the header is simply omitted.
      process.env.SS_SELF_HOST_PUBKEY = "not-a-pubkey";
      process.env.MM_SELF_HOST_PUBKEY = PUBKEY;
      const proxy = loadProxy("https://self-sown.com");
      const res = await proxy(buildRequest(HOST, "/shop"));
      expect(shopPubkey(res)).toBeNull();
    });
  });
});
