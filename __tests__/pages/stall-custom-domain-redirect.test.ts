/** @jest-environment node */

// Platform → custom-domain permanent redirect for pages/stall/[slug].tsx and
// pages/stall/[...stallPath].tsx. A seller with a verified custom domain used
// to serve identical content on BOTH hosts with different canonicals, so
// search engines indexed the platform copy separately and ranking split
// across the two hosts. The platform stall pages now permanently redirect to
// the custom domain — but only once the domain can actually serve HTTPS
// (verified + tls_status "active": DNS verification precedes certificate
// provisioning by up to ~24h and provisioning can fail), only when the
// seller isn't hidden, never when the request is already on the custom
// domain (loop), and never when the lookup fails (fail open).

import type { GetServerSidePropsContext } from "next";

jest.mock("@/components/storefront/storefront-layout", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/storefront/storefront-load-error", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/storefront/themed-stall-orders", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/storefront/themed-blog", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/utility-components/ss-spinner", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/utils/context/context", () => ({ ShopMapContext: {} }));
jest.mock("@/utils/storefront/use-storefront-lookup", () => ({
  useStorefrontLookup: jest.fn(),
}));
jest.mock("@/utils/api/agent-error", () => ({
  tryWriteAgentNotFound: jest.fn(() => false),
}));
jest.mock("@/utils/storefront/ssr-products", () => ({
  fetchSsrStallCatalog: jest.fn(async () => ({
    productEvents: [],
    catalogProducts: [],
    ssrProducts: [],
  })),
  toSsrSummary: jest.fn(),
}));

const PUBKEY = "ab".repeat(32);
const DOMAIN = "shop.naughtygoat.co";

// The custom-domains module under test is REAL — its verified + tls_status
// gate is the behavior being tested — so the DB is controlled through the
// db-service pool mock instead. `var` + the `mock` prefix: jest.mock
// factories may only reference hoisted mock-prefixed variables.
var mockDomainRow: { verified: boolean; tls_status: string } | null = null;
var mockDomainQueryError: Error | null = null;
var mockDomainQueryCount = 0;

const getMembershipView = jest.fn();
jest.mock("@/utils/pro/membership", () => ({
  getMembershipView: (...args: unknown[]) => getMembershipView(...args),
}));

const fetchShopProfileByPubkeyFromDb = jest.fn(
  async (..._args: unknown[]): Promise<any> => null
);
jest.mock("@/utils/db/db-service", () => ({
  // getDbPool is called at module scope by utils/db/custom-domains.ts, so it
  // must return a working pool shape at import time; query behavior is read
  // lazily from the mock* vars above so each test can set the domain row.
  getDbPool: () => ({
    query: async (sql: string) => {
      if (typeof sql === "string" && sql.includes("FROM custom_domains")) {
        mockDomainQueryCount += 1;
        if (mockDomainQueryError) throw mockDomainQueryError;
        return {
          rows: mockDomainRow
            ? [{ pubkey: PUBKEY_SAFE, domain: DOMAIN_SAFE, ...mockDomainRow }]
            : [],
        };
      }
      return { rows: [] };
    },
  }),
  fetchShopPubkeyBySlug: jest.fn(async () => PUBKEY_SAFE),
  fetchShopProfileByPubkeyFromDb: (...args: unknown[]) =>
    fetchShopProfileByPubkeyFromDb(...args),
  fetchProfileByPubkeyFromDb: jest.fn(async () => null),
  fetchProductByDTagAndPubkey: jest.fn(async () => null),
  fetchBlogPostsByPubkeyFromDb: jest.fn(async () => []),
  fetchProductsByPubkeyFromDb: jest.fn(async () => []),
}));

// jest.mock factories can't reference non-mock-prefixed consts, so the
// factory above uses these aliases; the real consts keep test bodies readable.
const PUBKEY_SAFE = PUBKEY;
const DOMAIN_SAFE = DOMAIN;

import { getServerSideProps as stallRootGssp } from "@/pages/stall/[slug]";
import { getServerSideProps as stallSubGssp } from "@/pages/stall/[...stallPath]";
import { resolvePlatformStallRedirect } from "@/utils/storefront/stall-custom-domain-redirect";

function shopEvent(storefront?: Record<string, unknown>) {
  return {
    id: "evt",
    pubkey: PUBKEY,
    created_at: 1,
    kind: 30019,
    tags: [],
    sig: "sig",
    content: JSON.stringify({
      name: "naughty goat co.",
      about: "goat milk products",
      ...(storefront ? { storefront } : {}),
    }),
  };
}

function ctx(args: {
  query: Record<string, unknown>;
  url: string;
  headers?: Record<string, string>;
}): GetServerSidePropsContext {
  return {
    query: args.query,
    req: { headers: args.headers ?? {}, url: args.url },
    res: {},
  } as unknown as GetServerSidePropsContext;
}

function redirectOf(
  res: unknown
): { destination: string; permanent: boolean } | null {
  if (res && typeof res === "object" && "redirect" in res) {
    return (res as { redirect: { destination: string; permanent: boolean } })
      .redirect;
  }
  return null;
}

function setDomain(tlsStatus: string | null) {
  mockDomainRow = tlsStatus ? { verified: true, tls_status: tlsStatus } : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDomainRow = { verified: true, tls_status: "active" };
  mockDomainQueryError = null;
  mockDomainQueryCount = 0;
  getMembershipView.mockResolvedValue({ isPro: true, isHidden: false });
  fetchShopProfileByPubkeyFromDb.mockResolvedValue(shopEvent());
});

describe("resolvePlatformStallRedirect", () => {
  const base = {
    servedOnCustomDomain: false,
    sellerHidden: false,
    pubkey: PUBKEY,
    publicPath: "",
    rawQuery: "",
  };

  it("returns the custom-domain URL for a verified domain with a live certificate", async () => {
    await expect(resolvePlatformStallRedirect(base)).resolves.toBe(
      `https://${DOMAIN}`
    );
  });

  it("appends the root-mapped subpath and preserves the query verbatim", async () => {
    await expect(
      resolvePlatformStallRedirect({
        ...base,
        publicPath: "/blog/spring-lamb",
        rawQuery: "utm_source=relay&ref=a%20b",
      })
    ).resolves.toBe(
      `https://${DOMAIN}/blog/spring-lamb?utm_source=relay&ref=a%20b`
    );
  });

  it("never redirects a request already served on the custom domain", async () => {
    await expect(
      resolvePlatformStallRedirect({ ...base, servedOnCustomDomain: true })
    ).resolves.toBeNull();
    expect(mockDomainQueryCount).toBe(0);
  });

  it("never redirects a hidden (lapsed) seller — their domain no longer serves", async () => {
    await expect(
      resolvePlatformStallRedirect({ ...base, sellerHidden: true })
    ).resolves.toBeNull();
    expect(mockDomainQueryCount).toBe(0);
  });

  it.each(["pending_dns", "dns_verified", "attached", "failed"])(
    "returns null while the certificate is not live (tls_status=%s)",
    async (tlsStatus) => {
      setDomain(tlsStatus);
      await expect(resolvePlatformStallRedirect(base)).resolves.toBeNull();
    }
  );

  it("returns null for an unverified domain row", async () => {
    mockDomainRow = { verified: false, tls_status: "active" };
    await expect(resolvePlatformStallRedirect(base)).resolves.toBeNull();
  });

  it("returns null when the seller has no domain row", async () => {
    setDomain(null);
    await expect(resolvePlatformStallRedirect(base)).resolves.toBeNull();
  });

  it("fails open (no redirect) when the domain lookup throws", async () => {
    mockDomainQueryError = new Error("db down");
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(resolvePlatformStallRedirect(base)).resolves.toBeNull();
    errSpy.mockRestore();
  });
});

describe("pages/stall/[slug] getServerSideProps", () => {
  const rootCtx = (
    headers?: Record<string, string>,
    url = "/stall/naughtygoatco"
  ) => ctx({ query: { slug: "naughtygoatco" }, url, headers });

  it("permanently redirects the platform stall root to the live custom domain", async () => {
    const res = await stallRootGssp(rootCtx());
    expect(redirectOf(res)).toEqual({
      destination: `https://${DOMAIN}`,
      permanent: true,
    });
  });

  it("preserves the query string on the redirect", async () => {
    const res = await stallRootGssp(
      rootCtx(undefined, "/stall/naughtygoatco?utm_source=relay")
    );
    expect(redirectOf(res)?.destination).toBe(
      `https://${DOMAIN}?utm_source=relay`
    );
  });

  it.each(["pending_dns", "dns_verified", "attached", "failed"])(
    "keeps serving the platform page while the certificate is not live (tls_status=%s)",
    async (tlsStatus) => {
      setDomain(tlsStatus);
      const res = await stallRootGssp(rootCtx());
      expect(redirectOf(res)).toBeNull();
      // The page must still render normally — the working platform stall is
      // always a valid response while the domain can't serve HTTPS.
      expect(res).toHaveProperty("props");
    }
  );

  it("serves normally when the request arrives ON the custom domain (no loop)", async () => {
    const res = await stallRootGssp(
      rootCtx({
        "x-ss-custom-domain-host": DOMAIN,
        "x-ss-original-path": "/",
      })
    );
    expect(redirectOf(res)).toBeNull();
    expect(mockDomainQueryCount).toBe(0);
  });

  it("serves normally for a hidden seller whose domain stopped resolving", async () => {
    getMembershipView.mockResolvedValue({ isPro: false, isHidden: true });
    const res = await stallRootGssp(rootCtx());
    expect(redirectOf(res)).toBeNull();
  });

  it("serves normally when the seller has no custom domain", async () => {
    setDomain(null);
    const res = await stallRootGssp(rootCtx());
    expect(redirectOf(res)).toBeNull();
  });

  it("still redirects when the seller is read-only lapsed but not hidden (domain still serves)", async () => {
    getMembershipView.mockResolvedValue({ isPro: false, isHidden: false });
    const res = await stallRootGssp(rootCtx());
    expect(redirectOf(res)?.destination).toBe(`https://${DOMAIN}`);
  });
});

describe("pages/stall/[...stallPath] getServerSideProps", () => {
  const subCtx = (
    path: string[],
    headers?: Record<string, string>,
    url = `/stall/${path.join("/")}`
  ) => ctx({ query: { stallPath: path }, url, headers });

  it("strips the /stall/<slug> prefix when redirecting a subpage (root-mapped domain)", async () => {
    const res = await stallSubGssp(
      subCtx(
        ["naughtygoatco", "blog", "spring-lamb"],
        undefined,
        "/stall/naughtygoatco/blog/spring-lamb?preview=1"
      )
    );
    expect(redirectOf(res)).toEqual({
      destination: `https://${DOMAIN}/blog/spring-lamb?preview=1`,
      permanent: true,
    });
  });

  it("redirects the orders dashboard subpage too (reachable on custom domains)", async () => {
    const res = await stallSubGssp(subCtx(["naughtygoatco", "orders"]));
    expect(redirectOf(res)?.destination).toBe(`https://${DOMAIN}/orders`);
  });

  it.each(["pending_dns", "dns_verified", "attached", "failed"])(
    "keeps serving the platform subpage while the certificate is not live (tls_status=%s)",
    async (tlsStatus) => {
      setDomain(tlsStatus);
      const res = await stallSubGssp(subCtx(["naughtygoatco", "shop"]));
      expect(redirectOf(res)).toBeNull();
      expect(res).toHaveProperty("props");
    }
  );

  it("serves normally on the custom domain itself (no loop)", async () => {
    const res = await stallSubGssp(
      subCtx(["naughtygoatco", "shop"], {
        "x-ss-custom-domain-host": DOMAIN,
        "x-ss-original-path": "/shop",
      })
    );
    expect(redirectOf(res)).toBeNull();
    expect(mockDomainQueryCount).toBe(0);
  });

  it("serves normally when the seller has no custom domain", async () => {
    setDomain(null);
    const res = await stallSubGssp(subCtx(["naughtygoatco", "shop"]));
    expect(redirectOf(res)).toBeNull();
  });
});
