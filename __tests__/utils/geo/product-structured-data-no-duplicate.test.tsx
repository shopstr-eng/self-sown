/** @jest-environment jsdom */

// Regression guard against a SECOND copy of the product/stall structured data
// being re-introduced. A hand-rolled client-side Product JSON-LD once rendered
// alongside the canonical server-side one; two Product nodes confuse crawlers
// and AI shopping agents, and the only thing that caught it was manual HTML
// inspection. These tests render the JSON-LD-emitting head components
// (DynamicHead + StructuredData) and assert a product page emits EXACTLY ONE
// schema.org Product node (plus the global Organization/WebSite) and a stall
// page emits EXACTLY ONE ItemList node. A source-scan test additionally fails
// if any client-side JSON-LD is reintroduced into the listing view.

import fs from "fs";
import path from "path";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";

import DynamicHead from "@/components/dynamic-meta-head";
import StructuredData from "@/components/structured-data";
import {
  buildProductJsonLd,
  buildItemListJsonLd,
} from "@/utils/geo/product-jsonld";
import { UCP_BITCOIN_CURRENCY } from "@/utils/ucp/money";
import type { UcpMoney } from "@/utils/ucp/money";
import type { UcpProduct } from "@/utils/ucp/types";
import type { OgMetaProps } from "@/components/og-head";

// next/head renders its children into a side-effecting head manager that isn't
// mounted in unit tests; mock it to a passthrough so the <script> tags land in
// the rendered DOM where we can count them.
jest.mock("next/head", () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const mockRouter = {
  pathname: "/",
  asPath: "/",
  query: {} as Record<string, unknown>,
};
jest.mock("next/router", () => ({
  useRouter: () => mockRouter,
}));

const usd = (amount: number): UcpMoney => ({
  currency: "USD",
  amount,
  exponent: 2,
  display: (amount / 100).toFixed(2),
});

const sats = (amount: number): UcpMoney => ({
  currency: UCP_BITCOIN_CURRENCY,
  amount,
  exponent: 8,
  display: `${amount} sat`,
});

function makeProduct(overrides: Partial<UcpProduct> = {}): UcpProduct {
  return {
    id: "evt-1",
    type: "product",
    title: "Raw Milk",
    description: "Fresh from the farm",
    url: "https://milk.market/listing/raw-milk",
    images: ["https://cdn.example/a.png"],
    price: usd(1200),
    categories: ["milk"],
    availability: "in_stock",
    inventory: { tracked: true, quantity: 5 },
    seller: {
      pubkey: "00".repeat(32),
      npub: "npub1seller",
      name: "St. John Creamery",
    },
    shipping: { type: "Free", cost: usd(0), pickupAvailable: false },
    paymentMethods: ["lightning", "cashu"],
    updatedAt: "2026-01-01T00:00:00.000Z",
    ext: {},
    ...overrides,
  };
}

// Parse every <script type="application/ld+json"> currently in the document and
// tally its top-level @type. safeJsonLdString escapes <, > and & to \uXXXX,
// which JSON.parse round-trips cleanly.
function jsonLdTypeCounts(): Record<string, number> {
  const scripts = Array.from(
    document.querySelectorAll('script[type="application/ld+json"]')
  );
  const counts: Record<string, number> = {};
  for (const script of scripts) {
    const raw = script.textContent || "";
    const node = JSON.parse(raw) as { "@type"?: string };
    const type = node["@type"] || "Unknown";
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function renderHead(ssrOgMeta: OgMetaProps, pathname: string) {
  mockRouter.pathname = pathname;
  mockRouter.asPath = pathname;
  return render(
    <>
      <StructuredData />
      <DynamicHead
        productEvents={[]}
        shopEvents={new Map()}
        profileData={new Map()}
        ssrOgMeta={ssrOgMeta}
      />
    </>
  );
}

describe("product structured-data: no duplicate Product node", () => {
  it("emits exactly one Product node plus the global Organization/WebSite", () => {
    const ssrOgMeta: OgMetaProps = {
      title: "Raw Milk",
      description: "Fresh from the farm",
      image: "https://cdn.example/a.png",
      url: "https://milk.market/listing/raw-milk",
      jsonLd: [buildProductJsonLd(makeProduct())],
    };

    renderHead(ssrOgMeta, "/listing/raw-milk");

    const counts = jsonLdTypeCounts();
    expect(counts.Product).toBe(1);
    expect(counts.Organization).toBe(1);
    expect(counts.WebSite).toBe(1);
    // No stall catalog node should leak onto a product page.
    expect(counts.ItemList).toBeUndefined();
  });

  it("still emits a single Product node for a bitcoin-priced listing", () => {
    const ssrOgMeta: OgMetaProps = {
      title: "Raw Milk",
      description: "Fresh from the farm",
      image: "https://cdn.example/a.png",
      url: "https://milk.market/listing/raw-milk",
      jsonLd: [
        buildProductJsonLd(
          makeProduct({
            price: sats(1500),
            shipping: { type: "Free", cost: sats(0), pickupAvailable: false },
          })
        ),
      ],
    };

    renderHead(ssrOgMeta, "/listing/raw-milk");

    const counts = jsonLdTypeCounts();
    expect(counts.Product).toBe(1);
  });
});

describe("stall structured-data: no duplicate ItemList node", () => {
  it("emits exactly one ItemList node plus the global Organization/WebSite", () => {
    const products = [
      makeProduct({ url: "https://milk.market/listing/a", title: "A" }),
      makeProduct({ url: "https://milk.market/listing/b", title: "B" }),
    ];
    const ssrOgMeta: OgMetaProps = {
      title: "Farm Stall",
      description: "Catalog",
      image: "https://cdn.example/a.png",
      url: "https://milk.market/stall/farm",
      jsonLd: [
        buildItemListJsonLd(products, {
          url: "https://milk.market/stall/farm",
          name: "Farm Stall",
        }),
      ],
    };

    renderHead(ssrOgMeta, "/stall/farm");

    const counts = jsonLdTypeCounts();
    expect(counts.ItemList).toBe(1);
    expect(counts.Organization).toBe(1);
    expect(counts.WebSite).toBe(1);
    // The catalog listing must not also emit a single-Product node.
    expect(counts.Product).toBeUndefined();
  });
});

describe("listing view stays free of client-side JSON-LD", () => {
  // The duplicate originated as a hand-rolled JSON-LD <script> inside the
  // client-rendered listing view. Structured data must flow ONLY through the
  // server-side ogMeta -> DynamicHead path, so the view must never re-introduce
  // its own application/ld+json builder.
  it("product-listing-view.tsx emits no application/ld+json", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "components/listing/product-listing-view.tsx"),
      "utf8"
    );
    expect(source).not.toContain("application/ld+json");
  });
});
