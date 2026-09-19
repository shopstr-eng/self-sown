/** @jest-environment node */

// SSR subpage validation for pages/stall/[...stallPath].tsx. Regression cover
// for the custom-domain 404s: the nav's built-in pages, footer policy slugs,
// and custom pages (nested content.storefront.pages, routed by SLUG) all used
// to hit the generic "unknown subpage" 404. The validator must mirror the
// client renderer exactly: slug-only page resolution, the shared policy
// resolver's semantics, flag-gated wallet/community, and the Pro entitlement
// strip (basicStorefront) — non-Pro sellers' persisted premium config must
// not validate routes the client cannot render.

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

const PUBKEY = "ab".repeat(32);
const fetchShopProfileByPubkeyFromDb = jest.fn();
const getMembershipView = jest.fn();
jest.mock("@/utils/pro/membership", () => ({
  getMembershipView: (...args: unknown[]) => getMembershipView(...args),
}));
jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
  fetchShopPubkeyBySlug: jest.fn(async () => PUBKEY),
  fetchShopProfileByPubkeyFromDb: (...args: unknown[]) =>
    fetchShopProfileByPubkeyFromDb(...args),
  fetchProfileByPubkeyFromDb: jest.fn(async () => null),
  fetchBlogPostsByPubkeyFromDb: jest.fn(async () => []),
}));

import { getServerSideProps } from "@/pages/stall/[...stallPath]";

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

function ctx(path: string[]): GetServerSidePropsContext {
  return {
    query: { stallPath: path },
    req: { headers: {} },
    res: {},
  } as unknown as GetServerSidePropsContext;
}

const PAGES = [
  { id: "page-1774641080229", slug: "about", title: "About", sections: [] },
];

async function status(path: string[]): Promise<number> {
  const res = await getServerSideProps(ctx(path));
  return "notFound" in res ? 404 : 200;
}

describe("stall subpage SSR validation (Pro seller)", () => {
  beforeEach(() => {
    fetchShopProfileByPubkeyFromDb.mockReset();
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(
      shopEvent({ pages: PAGES })
    );
    getMembershipView.mockReset();
    getMembershipView.mockResolvedValue({ isPro: true });
  });

  it("serves every ungated built-in route", async () => {
    for (const slug of [
      "shop",
      "orders",
      "blog",
      "my-listings",
      "order-confirmation",
    ]) {
      expect(await status(["naughtygoatco", slug])).toBe(200);
    }
  });

  it("gates wallet and community on their storefront flags", async () => {
    expect(await status(["naughtygoatco", "wallet"])).toBe(404);
    expect(await status(["naughtygoatco", "community"])).toBe(404);
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(
      shopEvent({ showWalletPage: true, showCommunityPage: true })
    );
    expect(await status(["naughtygoatco", "wallet"])).toBe(200);
    expect(await status(["naughtygoatco", "community"])).toBe(200);
  });

  it("serves policy pages enabled by default (no footer config)", async () => {
    for (const slug of [
      "return-policy",
      "terms-of-service",
      "privacy-policy",
      "cancellation-policy",
    ]) {
      expect(await status(["naughtygoatco", slug])).toBe(200);
    }
  });

  it("mirrors the shared policy resolver for every stored shape", async () => {
    // Explicitly disabled -> 404 (others stay enabled)
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(
      shopEvent({
        footer: { policies: { privacyPolicy: { enabled: false, content: "" } } },
      })
    );
    expect(await status(["naughtygoatco", "privacy-policy"])).toBe(404);
    expect(await status(["naughtygoatco", "return-policy"])).toBe(200);

    // Stored but missing `enabled` -> renderer's (stored || default).enabled
    // is falsy, so it renders no policy; SSR must 404 too.
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(
      shopEvent({ footer: { policies: { returnPolicy: { content: "x" } } } })
    );
    expect(await status(["naughtygoatco", "return-policy"])).toBe(404);

    // Stored and enabled -> 200 (truthy check, not === true)
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(
      shopEvent({
        footer: { policies: { returnPolicy: { enabled: 1, content: "x" } } },
      })
    );
    expect(await status(["naughtygoatco", "return-policy"])).toBe(200);

    // Null stored value -> falls back to the default (enabled)
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(
      shopEvent({ footer: { policies: { returnPolicy: null } } })
    );
    expect(await status(["naughtygoatco", "return-policy"])).toBe(200);
  });

  it("serves custom pages by slug from content.storefront.pages", async () => {
    expect(await status(["naughtygoatco", "about"])).toBe(200);
  });

  it("404s a page id URL — the renderer only ever resolves slugs", async () => {
    expect(await status(["naughtygoatco", "page-1774641080229"])).toBe(404);
  });

  it("ignores a legacy top-level pages array the renderer cannot read", async () => {
    fetchShopProfileByPubkeyFromDb.mockResolvedValue({
      ...shopEvent(),
      content: JSON.stringify({ name: "legacy", pages: PAGES }),
    });
    expect(await status(["naughtygoatco", "about"])).toBe(404);
  });

  it("404s unknown subpages", async () => {
    expect(await status(["naughtygoatco", "nope"])).toBe(404);
  });

  it("rejects extra path segments beyond blog/<post>", async () => {
    expect(await status(["naughtygoatco", "about", "extra"])).toBe(404);
    expect(await status(["naughtygoatco", "shop", "extra"])).toBe(404);
    expect(await status(["naughtygoatco", "blog", "a", "b"])).toBe(404);
  });

  it("404s policy/custom pages when the shop event itself is missing", async () => {
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(null);
    expect(await status(["naughtygoatco", "return-policy"])).toBe(404);
    expect(await status(["naughtygoatco", "about"])).toBe(404);
  });
});

describe("stall subpage SSR validation (non-Pro seller)", () => {
  beforeEach(() => {
    fetchShopProfileByPubkeyFromDb.mockReset();
    fetchShopProfileByPubkeyFromDb.mockResolvedValue(
      shopEvent({
        pages: PAGES,
        showWalletPage: true,
        showCommunityPage: true,
        footer: { policies: { returnPolicy: { enabled: false, content: "" } } },
      })
    );
    getMembershipView.mockReset();
    getMembershipView.mockResolvedValue({ isPro: false });
  });

  it("404s persisted custom pages — the client strips them for non-Pro", async () => {
    expect(await status(["naughtygoatco", "about"])).toBe(404);
  });

  it("404s wallet/community even with persisted flags — stripped for non-Pro", async () => {
    expect(await status(["naughtygoatco", "wallet"])).toBe(404);
    expect(await status(["naughtygoatco", "community"])).toBe(404);
  });

  it("serves default policies and ignores stored ones, like the stripped client storefront", async () => {
    // Stored disabled policy is stripped with the footer, so the client falls
    // back to the enabled default policy — SSR must agree.
    expect(await status(["naughtygoatco", "return-policy"])).toBe(200);
    expect(await status(["naughtygoatco", "privacy-policy"])).toBe(200);
  });

  it("still serves ungated built-ins", async () => {
    expect(await status(["naughtygoatco", "shop"])).toBe(200);
    expect(await status(["naughtygoatco", "order-confirmation"])).toBe(200);
  });
});
