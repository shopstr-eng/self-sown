/**
 * @jest-environment jsdom
 *
 * Buyer-facing SHIPPING cross-currency conversion coverage.
 *
 * Task #96 (cart-invoice-card-fx-multicurrency.test.tsx) guarded the per-line
 * and grand-total FX fallbacks for a PICKUP cart. The `nativeTotalCost` effect
 * has a SEPARATE null-fallback branch for SHIPPING: when a seller denominates
 * shipping in a different currency than the cart (e.g. sats shipping on a USD
 * cart) the per-seller shipping is converted into the cart's display currency
 * via the resilient FX helpers (getSatoshiValueResilient + getFiatValueResilient
 * from utils/stripe/currency). On a persistent exchange-rate outage those
 * helpers RETURN null (never throw), and this branch deliberately degrades the
 * shipping figure to 0 — NOT to the raw foreign amount — so a sats shipping cost
 * (e.g. 38,000) is never added to a USD cart as if it were already dollars
 * (which would inflate a $10 cart to $38,010). The grand total must still render
 * (no NaN, no crash); it simply omits the shipping it can't safely convert.
 *
 * This file mirrors the multi-currency scaffolding but switches the cart off
 * "Pickup" (which auto-selects the address-free "contact" flow) to an
 * "Added Cost" shipping cart, which auto-selects the "shipping" flow and so
 * exercises the shipping branch of the `nativeTotalCost` effect.
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

// Override ONLY the two resilient display helpers; keep every other currency
// export real so the test exercises genuine rendering math.
const getSatoshiValueResilientMock = jest.fn();
const getFiatValueResilientMock = jest.fn();
jest.mock("@/utils/stripe/currency", () => {
  const actual = jest.requireActual("@/utils/stripe/currency");
  return {
    ...actual,
    getSatoshiValueResilient: (...args: unknown[]) =>
      getSatoshiValueResilientMock(...args),
    getFiatValueResilient: (...args: unknown[]) =>
      getFiatValueResilientMock(...args),
  };
});

// Lightweight HeroUI stubs — the real components rely on portals/animations
// that add noise without affecting the price-display logic under test.
jest.mock(
  "@heroui/react",
  () => {
    const passthrough =
      (tag: string) =>
      ({ children, ...props }: { children?: ReactNode }) => {
        const {
          onPress: _onPress,
          startContent,
          endContent,
          ...rest
        } = props as Record<string, unknown>;
        return (
          <div data-hero={tag} {...(rest as object)}>
            {startContent as ReactNode}
            {children}
            {endContent as ReactNode}
          </div>
        );
      };
    return {
      __esModule: true,
      Button: passthrough("button"),
      Image: ({ alt }: { src?: string; alt?: string }) => (
        <div data-hero="image" aria-label={alt} />
      ),
      Modal: passthrough("modal"),
      ModalContent: passthrough("modal-content"),
      ModalHeader: passthrough("modal-header"),
      ModalBody: passthrough("modal-body"),
      ModalFooter: passthrough("modal-footer"),
      Select: passthrough("select"),
      SelectItem: passthrough("select-item"),
      Input: passthrough("input"),
      Spinner: () => <div data-testid="spinner" />,
      Checkbox: passthrough("checkbox"),
      useDisclosure: () => ({
        isOpen: false,
        onOpen: jest.fn(),
        onClose: jest.fn(),
      }),
    };
  },
  { virtual: true }
);

// Heavy child components are irrelevant to the Order Summary price display —
// stub them.
jest.mock("@/components/utility-components/wallet-recovery-modal", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/utility-components/payment-countdown", () => ({
  __esModule: true,
  PaymentCountdown: () => null,
  PaymentElapsed: () => null,
}));
jest.mock("@/components/utility-components/failure-modal", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/utility-components/stripe-card-form", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/utility-components/dropdowns/country-dropdown", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/utility-components/address-picker", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/sign-in/SignInModal", () => ({
  __esModule: true,
  default: () => null,
}));

// Avoid real key generation / relay / localStorage side effects on mount.
jest.mock("@/utils/nostr/nostr-helper-functions", () => ({
  __esModule: true,
  generateKeys: jest.fn(async () => ({ nsec: "nsec-test", npub: "npub-test" })),
  getLocalStorageData: jest.fn(() => ({
    mints: [],
    tokens: [],
    history: [],
    nwcInfo: "",
  })),
  getSavedAddresses: jest.fn(() => []),
  saveAddress: jest.fn(),
  constructGiftWrappedEvent: jest.fn(),
  constructMessageSeal: jest.fn(),
  constructMessageGiftWrap: jest.fn(),
  sendGiftWrappedMessageEvent: jest.fn(),
  publishProofEvent: jest.fn(),
}));

jest.mock("@milk-market/nostr", () => ({
  __esModule: true,
  createSellerActionAuthEventTemplate: jest.fn(() => ({})),
}));

// ESM-flavored leaf libs the cart imports at module load but never exercises in
// this render path — stub so importing the component never trips the
// transformer.
jest.mock("@getalby/sdk", () => ({
  __esModule: true,
  NostrWebLNProvider: class {},
}));
jest.mock("qrcode", () => ({
  __esModule: true,
  default: { toDataURL: jest.fn(async () => "data:image/png;base64,stub") },
}));
jest.mock("uuid", () => ({
  __esModule: true,
  v4: () => "00000000-0000-0000-0000-000000000000",
}));

import CartInvoiceCard from "@/components/cart-invoice-card";
import type { ProductData } from "@/utils/parsers/product-parser-functions";

const SELLER_PUBKEY = "b".repeat(64);
const USD_PRODUCT_ID = "usd-product";

// A USD product whose seller denominates SHIPPING in sats (38,000 sats — the
// same illustrative figure called out in the component's own comment). The cart
// currency resolves to USD, so the sats shipping must be FX-converted into USD
// before it's added; this is the value that degrades to 0 on an outage rather
// than being added raw as if it were $38,000.
const SHIPPING_IN_SATS = 38000;

function buildProduct(overrides: Partial<ProductData> = {}): ProductData {
  return {
    id: USD_PRODUCT_ID,
    pubkey: SELLER_PUBKEY,
    createdAt: 1710000000,
    title: "Raw Whole Milk",
    summary: "A gallon of fresh raw milk",
    publishedAt: "",
    images: ["https://example.com/milk.png"],
    categories: [],
    location: "",
    price: 10,
    currency: "USD",
    totalCost: 10,
    // "Added Cost" (not "Pickup") makes the order-type auto-selector pick the
    // "shipping" flow, which is the only flow that runs the shipping branch of
    // the nativeTotalCost effect.
    shippingType: "Added Cost",
    shippingCost: SHIPPING_IN_SATS,
    shippingCurrency: "sats",
    ...overrides,
  } as ProductData;
}

const noopSetters = {
  setInvoiceIsPaid: jest.fn(),
  setInvoiceGenerationFailed: jest.fn(),
  setCashuPaymentSent: jest.fn(),
  setCashuPaymentFailed: jest.fn(),
};

// The single-line item is $10 in USD (1,000 sats); the only cross-currency work
// in the cart is the seller's sats-denominated shipping.
function renderCart() {
  return render(
    <CartInvoiceCard
      products={[buildProduct()]}
      quantities={{ [USD_PRODUCT_ID]: 1 }}
      shippingTypes={{ [USD_PRODUCT_ID]: "Added Cost" }}
      totalCostsInSats={{ [USD_PRODUCT_ID]: 1000 }}
      subtotalCost={1000}
      {...noopSetters}
    />
  );
}

beforeAll(() => {
  // The Stripe-merchant check fetches on mount; report the single seller as a
  // chargeable merchant so the card-payment button (which renders the native
  // total) is present.
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      hasStripeAccount: true,
      chargesEnabled: true,
      connectedAccountId: "acct_test",
    }),
  })) as unknown as typeof fetch;
});

beforeEach(() => {
  getSatoshiValueResilientMock.mockReset();
  getFiatValueResilientMock.mockReset();
});

describe("CartInvoiceCard shipping FX conversion", () => {
  it("degrades sats shipping to 0 (not the raw amount) when the rate is unavailable", async () => {
    // Persistent outage: every resilient lookup yields null. The sats→USD
    // shipping conversion then yields null, so the shipping branch falls back to
    // 0 rather than adding the raw 38,000 as dollars. The grand total is the
    // un-shipped item subtotal of $10.00 — never $38,010 and never NaN.
    getSatoshiValueResilientMock.mockResolvedValue(null);
    getFiatValueResilientMock.mockResolvedValue(null);

    renderCart();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;

    await waitFor(() => {
      expect(totalRow).toHaveTextContent("10.00 USD");
    });
    // The raw-foreign-amount regression would show $38,010.00 — assert it does
    // NOT, proving shipping degraded to 0.
    expect(totalRow.textContent ?? "").not.toMatch(/38,010/);
    expect(totalRow.textContent ?? "").not.toMatch(/NaN/);

    // The sats-denominated total is unaffected by the fiat-rate outage (sats
    // shipping needs no conversion to stay in sats): 1,000 + 38,000 = 39,000.
    expect(totalRow).toHaveTextContent("39,000 sats");

    // The shipping branch attempted the sats→cart-currency conversion.
    await waitFor(() => {
      expect(getFiatValueResilientMock).toHaveBeenCalled();
    });

    // The card button surfaces the same degraded USD total — no NaN, no crash.
    const cardButton = await screen.findByText(/Pay with Card:/);
    expect(cardButton).toHaveTextContent("10.00 USD");

    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it("converts sats shipping into the cart currency and adds it when the rate is available", async () => {
    // Healthy feed: the 38,000-sat shipping converts to $15.00, so the cart
    // total is the $10 item + $15 shipping = $25.00.
    getSatoshiValueResilientMock.mockResolvedValue(SHIPPING_IN_SATS);
    getFiatValueResilientMock.mockResolvedValue(15);

    renderCart();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;

    await waitFor(() => {
      expect(totalRow).toHaveTextContent("25.00 USD");
    });
    expect(totalRow).toHaveTextContent("39,000 sats");
    expect(totalRow.textContent ?? "").not.toMatch(/NaN/);

    const cardButton = await screen.findByText(/Pay with Card:/);
    expect(cardButton).toHaveTextContent("25.00 USD");

    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});

// ---------------------------------------------------------------------------
// Task #98: the same `shippingInCartCurrency = fiatVal ?? 0` fallback in the
// nativeTotalCost effect runs for two more cart shapes the simple single-line
// case above never reaches. Both must degrade shipping to 0 (never the raw
// foreign amount, never NaN) on an FX outage and convert it normally when the
// resilient helpers return values.
// ---------------------------------------------------------------------------

const PRODUCT_A_ID = "usd-product-a";
const PRODUCT_B_ID = "usd-product-b";

// Two same-seller USD products. The seller denominates shipping in sats; the
// HIGHEST static shipping wins consolidation, so product B's 38,000-sat
// shipping is the figure that must be FX-converted into USD (or degrade to 0).
function buildProductA(overrides: Partial<ProductData> = {}): ProductData {
  return buildProduct({
    id: PRODUCT_A_ID,
    title: "Raw Whole Milk",
    shippingType: "Added Cost",
    shippingCost: 1000,
    shippingCurrency: "sats",
    ...overrides,
  });
}

function buildProductB(overrides: Partial<ProductData> = {}): ProductData {
  return buildProduct({
    id: PRODUCT_B_ID,
    title: "Raw Cream",
    shippingType: "Added Cost",
    shippingCost: SHIPPING_IN_SATS,
    shippingCurrency: "sats",
    ...overrides,
  });
}

// CONSOLIDATED multi-product shipping: two products, same seller, both "Added
// Cost", which auto-selects the pure "shipping" flow. Because the seller has
// >1 product, the shipping branch derives its currency from
// getConsolidatedShippingForSeller (the highest-shipping product, B) rather
// than getEffectiveSingleProductShipping.
function renderConsolidatedCart() {
  return render(
    <CartInvoiceCard
      products={[buildProductA(), buildProductB()]}
      quantities={{ [PRODUCT_A_ID]: 1, [PRODUCT_B_ID]: 1 }}
      shippingTypes={{
        [PRODUCT_A_ID]: "Added Cost",
        [PRODUCT_B_ID]: "Added Cost",
      }}
      totalCostsInSats={{ [PRODUCT_A_ID]: 1000, [PRODUCT_B_ID]: 1000 }}
      subtotalCost={2000}
      {...noopSetters}
    />
  );
}

describe("CartInvoiceCard consolidated multi-product shipping FX conversion", () => {
  it("degrades consolidated sats shipping to 0 (not the raw amount) when the rate is unavailable", async () => {
    // Outage: the sats→USD conversion of the consolidated (highest) shipping
    // yields null, so it falls back to 0. The grand total is the two un-shipped
    // $10 items = $20.00 — never $38,020 and never NaN.
    getSatoshiValueResilientMock.mockResolvedValue(null);
    getFiatValueResilientMock.mockResolvedValue(null);

    renderConsolidatedCart();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;

    await waitFor(() => {
      expect(totalRow).toHaveTextContent("20.00 USD");
    });
    // The raw-foreign-amount regression would show $38,020.00 — assert it does
    // NOT, proving consolidated shipping degraded to 0.
    expect(totalRow.textContent ?? "").not.toMatch(/38,020/);
    expect(totalRow.textContent ?? "").not.toMatch(/NaN/);

    // The sats-denominated total is unaffected by the fiat-rate outage (sats
    // shipping needs no conversion to stay in sats): 2,000 items + 38,000
    // consolidated shipping = 40,000.
    expect(totalRow).toHaveTextContent("40,000 sats");

    // The shipping branch attempted the sats→cart-currency conversion.
    await waitFor(() => {
      expect(getFiatValueResilientMock).toHaveBeenCalled();
    });

    const cardButton = await screen.findByText(/Pay with Card:/);
    expect(cardButton).toHaveTextContent("20.00 USD");

    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it("converts consolidated sats shipping into the cart currency and adds it when the rate is available", async () => {
    // Healthy feed: the 38,000-sat consolidated shipping converts to $15.00, so
    // the cart total is the $20 items + $15 shipping = $35.00.
    getSatoshiValueResilientMock.mockResolvedValue(SHIPPING_IN_SATS);
    getFiatValueResilientMock.mockResolvedValue(15);

    renderConsolidatedCart();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;

    await waitFor(() => {
      expect(totalRow).toHaveTextContent("35.00 USD");
    });
    expect(totalRow).toHaveTextContent("40,000 sats");
    expect(totalRow.textContent ?? "").not.toMatch(/NaN/);

    const cardButton = await screen.findByText(/Pay with Card:/);
    expect(cardButton).toHaveTextContent("35.00 USD");

    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});

// COMBINED (mixed delivery) order type: two same-seller products with DIFFERENT
// shipping types ("Added Cost" + "Free"). Mixed shipping types auto-select the
// "combined" flow, and with no pickup products the pickup-vs-shipping
// preference defaults to "shipping" — so this exercises the
// `formType === "combined" && shippingPickupPreference === "shipping"` arm of
// the shipping branch, which the pure-"shipping" cases above never reach. The
// "Free" product carries no shipping cost, so the consolidated highest is the
// 38,000-sat "Added Cost" product whose currency must be FX-converted.
function renderCombinedCart() {
  return render(
    <CartInvoiceCard
      products={[
        buildProductA({ shippingCost: SHIPPING_IN_SATS }),
        buildProductB({ shippingType: "Free", shippingCost: 0 }),
      ]}
      quantities={{ [PRODUCT_A_ID]: 1, [PRODUCT_B_ID]: 1 }}
      shippingTypes={{ [PRODUCT_A_ID]: "Added Cost", [PRODUCT_B_ID]: "Free" }}
      totalCostsInSats={{ [PRODUCT_A_ID]: 1000, [PRODUCT_B_ID]: 1000 }}
      subtotalCost={2000}
      {...noopSetters}
    />
  );
}

describe("CartInvoiceCard combined (mixed delivery) shipping FX conversion", () => {
  it("degrades sats shipping to 0 (not the raw amount) on the combined flow when the rate is unavailable", async () => {
    // Outage on the combined/shipping arm: the sats→USD conversion of the
    // 38,000-sat shipping yields null, so it falls back to 0. The total is the
    // two $10 items = $20.00 — never $38,020 and never NaN.
    getSatoshiValueResilientMock.mockResolvedValue(null);
    getFiatValueResilientMock.mockResolvedValue(null);

    renderCombinedCart();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;

    await waitFor(() => {
      expect(totalRow).toHaveTextContent("20.00 USD");
    });
    expect(totalRow.textContent ?? "").not.toMatch(/38,020/);
    expect(totalRow.textContent ?? "").not.toMatch(/NaN/);

    // sats total: 2,000 items + 38,000 shipping = 40,000 (sats needs no FX).
    expect(totalRow).toHaveTextContent("40,000 sats");

    await waitFor(() => {
      expect(getFiatValueResilientMock).toHaveBeenCalled();
    });

    const cardButton = await screen.findByText(/Pay with Card:/);
    expect(cardButton).toHaveTextContent("20.00 USD");

    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it("converts sats shipping into the cart currency on the combined flow when the rate is available", async () => {
    // Healthy feed: the 38,000-sat shipping converts to $15.00, so the cart
    // total is the $20 items + $15 shipping = $35.00.
    getSatoshiValueResilientMock.mockResolvedValue(SHIPPING_IN_SATS);
    getFiatValueResilientMock.mockResolvedValue(15);

    renderCombinedCart();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;

    await waitFor(() => {
      expect(totalRow).toHaveTextContent("35.00 USD");
    });
    expect(totalRow).toHaveTextContent("40,000 sats");
    expect(totalRow.textContent ?? "").not.toMatch(/NaN/);

    const cardButton = await screen.findByText(/Pay with Card:/);
    expect(cardButton).toHaveTextContent("35.00 USD");

    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});

// ---------------------------------------------------------------------------
// Task #99: in a COMBINED (mixed delivery) cart that mixes a SHIPPED product
// with a PICKUP product, the fiat (nativeTotalCost) and sats (totalCost
// recompute) paths must charge shipping for the SAME set of products. The sats
// path already skips any product whose per-product shipping type isn't "Added
// Cost"/"Free"; the fiat path used to iterate every seller WITHOUT that gate,
// so it would fold a pickup seller's shipping into the card total while the
// sats total left it out — two different grand totals for one cart depending on
// payment method. This pins the parity.
// ---------------------------------------------------------------------------

const SELLER_TWO_PUBKEY = "c".repeat(64);
const COMBINED_SHIPPED_ID = "combined-shipped";
const COMBINED_PICKUP_ID = "combined-pickup";

// Shipped product (seller 1): sats-denominated shipping that gets FX-converted
// into the USD cart currency for the fiat total. At the mock's 1,000 sats =
// $1.00 rate, 38,000 sats → $38.00.
const SHIPPED_SHIPPING_SATS = 38000;
// Pickup product (seller 2): carries a HIGHER shipping cost that must NEVER be
// charged because the buyer picks it up. The pre-fix fiat path would add this
// seller's $50 shipping (a separate, unseen seller); the sats path always
// skipped it via the per-product gate.
const PICKUP_SHIPPING_SATS = 50000;

// Two sellers, mixed delivery: one "Added Cost" shipped product and one
// pure-"Pickup" product. Mixed shipping types auto-select the "combined" flow;
// "Pickup" (not "Free/Pickup"/"Added Cost/Pickup") leaves
// hasMixedShippingWithPickup false, so the pickup-vs-shipping preference stays
// the default "shipping" and both total effects run their combined arms.
function renderCombinedWithPickupCart() {
  return render(
    <CartInvoiceCard
      products={[
        buildProduct({
          id: COMBINED_SHIPPED_ID,
          pubkey: SELLER_PUBKEY,
          title: "Raw Whole Milk",
          shippingType: "Added Cost",
          shippingCost: SHIPPED_SHIPPING_SATS,
          shippingCurrency: "sats",
        }),
        buildProduct({
          id: COMBINED_PICKUP_ID,
          pubkey: SELLER_TWO_PUBKEY,
          title: "Raw Cream (pickup)",
          shippingType: "Pickup",
          shippingCost: PICKUP_SHIPPING_SATS,
          shippingCurrency: "sats",
        }),
      ]}
      quantities={{ [COMBINED_SHIPPED_ID]: 1, [COMBINED_PICKUP_ID]: 1 }}
      shippingTypes={{
        [COMBINED_SHIPPED_ID]: "Added Cost",
        [COMBINED_PICKUP_ID]: "Pickup",
      }}
      totalCostsInSats={{
        [COMBINED_SHIPPED_ID]: 1000,
        [COMBINED_PICKUP_ID]: 1000,
      }}
      subtotalCost={2000}
      {...noopSetters}
    />
  );
}

describe("CartInvoiceCard combined cart pickup shipping parity (fiat vs sats)", () => {
  it("charges shipping for the same products in the card and Bitcoin totals (pickup product excluded from both)", async () => {
    // Resilient conversions reflect a 1,000 sats = $1.00 rate so each seller's
    // sats shipping maps to a distinct USD figure: shipped 38,000 → $38.00,
    // pickup 50,000 → $50.00. Only getFiatValueResilient is hit on the sats→USD
    // path (the SATS branch short-circuits getSatoshiValueResilient).
    getSatoshiValueResilientMock.mockImplementation(
      async ({ amount }: { amount: number }) => amount
    );
    getFiatValueResilientMock.mockImplementation(
      async ({ satoshi }: { satoshi: number }) => satoshi / 1000
    );

    renderCombinedWithPickupCart();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;

    // Fiat (card) total: $20 items + ONLY the shipped seller's $38 shipping =
    // $58.00. The pickup seller's $50 is excluded. The pre-fix bug would have
    // produced $108.00 ($20 + $38 + $50).
    await waitFor(() => {
      expect(totalRow).toHaveTextContent("58.00 USD");
    });
    expect(totalRow.textContent ?? "").not.toMatch(/108/);
    expect(totalRow.textContent ?? "").not.toMatch(/NaN/);

    // Sats (Bitcoin) total: 2,000 items + ONLY the shipped seller's 38,000 sats
    // = 40,000 sats. The pickup seller's 50,000 is excluded; a 90,000 total
    // would mean the pickup shipping leaked in.
    expect(totalRow).toHaveTextContent("40,000 sats");
    expect(totalRow.textContent ?? "").not.toMatch(/90,000/);

    // The card-payment button surfaces the same parity'd fiat total.
    const cardButton = await screen.findByText(/Pay with Card:/);
    expect(cardButton).toHaveTextContent("58.00 USD");

    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});

// ---------------------------------------------------------------------------
// Task #100: a COMBINED cart that mixes a flexible "Added Cost/Pickup" product
// (which makes hasMixedShippingWithPickup true and surfaces the
// shipping-vs-pickup preference selector) with a plain "Added Cost" product.
// While the default preference is "shipping" BOTH totals charge the "Added
// Cost" product's shipping. When the buyer flips the preference to pickup
// ("contact"), the fiat (nativeTotalCost) effect already drops ALL shipping
// because its whole accumulation is gated on
// `shippingPickupPreference === "shipping"`. The sats (totalCost recompute)
// effect used to omit that preference gate and kept charging the "Added Cost"
// shipping — two different grand totals for one cart on the pickup-vs-shipping
// axis. This pins the parity: after switching to pickup, neither total charges
// shipping.
// ---------------------------------------------------------------------------

const PREF_SHIPPED_ID = "pref-shipped";
const PREF_FLEX_ID = "pref-flex";

// Shipped-only product (seller 1): a plain "Added Cost" line whose sats
// shipping (38,000 → $38.00 at the 1,000 sats = $1.00 mock rate) passes the
// per-product gate, so it is the shipping the preference toggle must drop.
const PREF_SHIPPED_SATS = 38000;
// Flexible product (seller 2): "Added Cost/Pickup" — present only to make the
// cart mixed-with-pickup so the preference selector appears. Its own shipping
// is always skipped by the per-product gate regardless of preference.
const PREF_FLEX_SATS = 50000;

const SELLER_THREE_PUBKEY = "d".repeat(64);

function renderCombinedPickupPreferenceCart() {
  return render(
    <CartInvoiceCard
      products={[
        buildProduct({
          id: PREF_SHIPPED_ID,
          pubkey: SELLER_PUBKEY,
          title: "Raw Whole Milk",
          shippingType: "Added Cost",
          shippingCost: PREF_SHIPPED_SATS,
          shippingCurrency: "sats",
        }),
        buildProduct({
          id: PREF_FLEX_ID,
          pubkey: SELLER_THREE_PUBKEY,
          title: "Raw Cream (ship or pickup)",
          shippingType: "Added Cost/Pickup",
          shippingCost: PREF_FLEX_SATS,
          shippingCurrency: "sats",
        }),
      ]}
      quantities={{ [PREF_SHIPPED_ID]: 1, [PREF_FLEX_ID]: 1 }}
      shippingTypes={{
        [PREF_SHIPPED_ID]: "Added Cost",
        [PREF_FLEX_ID]: "Added Cost/Pickup",
      }}
      totalCostsInSats={{ [PREF_SHIPPED_ID]: 1000, [PREF_FLEX_ID]: 1000 }}
      subtotalCost={2000}
      {...noopSetters}
    />
  );
}

describe("CartInvoiceCard combined cart pickup preference shipping parity", () => {
  it("drops shipping from BOTH the fiat and sats totals when the preference is switched to pickup", async () => {
    // 1,000 sats = $1.00 in both directions so the shipped seller's 38,000-sat
    // shipping maps to $38.00.
    getSatoshiValueResilientMock.mockImplementation(
      async ({ amount }: { amount: number }) => amount
    );
    getFiatValueResilientMock.mockImplementation(
      async ({ satoshi }: { satoshi: number }) => satoshi / 1000
    );

    renderCombinedPickupPreferenceCart();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;

    // Default preference is "shipping": both totals include the "Added Cost"
    // product's shipping. Fiat = $20 items + $38 shipping = $58.00; sats =
    // 2,000 items + 38,000 shipping = 40,000.
    await waitFor(() => {
      expect(totalRow).toHaveTextContent("58.00 USD");
    });
    await waitFor(() => {
      expect(totalRow).toHaveTextContent("40,000 sats");
    });

    // Flip to pickup. The selector's "Pickup" option carries the unique
    // subtitle below; click its enclosing <button>.
    const pickupSubtitle = await screen.findByText(
      "Arrange pickup for products that offer it"
    );
    const pickupButton = pickupSubtitle.closest("button");
    expect(pickupButton).not.toBeNull();
    fireEvent.click(pickupButton as HTMLButtonElement);

    // After switching to pickup, BOTH totals must drop ALL shipping: fiat back
    // to the $20 items, sats back to the 2,000 items. The pre-fix sats path
    // would stay at 40,000 (and fiat at $58) — assert neither lingers.
    await waitFor(() => {
      expect(totalRow).toHaveTextContent("20.00 USD");
    });
    await waitFor(() => {
      expect(totalRow).toHaveTextContent("2,000 sats");
    });
    expect(totalRow.textContent ?? "").not.toMatch(/58\.00/);
    expect(totalRow.textContent ?? "").not.toMatch(/40,000/);
    expect(totalRow.textContent ?? "").not.toMatch(/NaN/);

    // The card-payment button surfaces the same no-shipping fiat total.
    const cardButton = await screen.findByText(/Pay with Card:/);
    expect(cardButton).toHaveTextContent("20.00 USD");

    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});

// ---------------------------------------------------------------------------
// Task #101: the reverse round-trip of Task #100. After a buyer flips the
// preference to pickup ("contact") — which drops ALL shipping from BOTH the
// fiat and sats totals — flipping it back to "Free or added shipping"
// ("shipping") must RE-ADD the "Added Cost" product's shipping to BOTH totals.
// The fiat (nativeTotalCost) effect re-accumulates shipping because its whole
// accumulation is gated on `shippingPickupPreference === "shipping"`; the sats
// path is restored by the inline "shipping" button handler (which recomputes
// totalCost) and the reactive recompute effect. A regression in either would
// leave the buyer undercharged (shipping silently dropped) after the
// round-trip. This pins the parity: shipping comes back in both totals.
// ---------------------------------------------------------------------------

describe("CartInvoiceCard combined cart pickup→shipping round-trip parity", () => {
  it("re-adds shipping to BOTH the fiat and sats totals when switched back from pickup to shipping", async () => {
    // 1,000 sats = $1.00 in both directions so the shipped seller's 38,000-sat
    // shipping maps to $38.00.
    getSatoshiValueResilientMock.mockImplementation(
      async ({ amount }: { amount: number }) => amount
    );
    getFiatValueResilientMock.mockImplementation(
      async ({ satoshi }: { satoshi: number }) => satoshi / 1000
    );

    renderCombinedPickupPreferenceCart();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;

    // Default preference is "shipping": both totals include the "Added Cost"
    // product's shipping. Fiat = $20 items + $38 shipping = $58.00; sats =
    // 2,000 items + 38,000 shipping = 40,000.
    await waitFor(() => {
      expect(totalRow).toHaveTextContent("58.00 USD");
    });
    await waitFor(() => {
      expect(totalRow).toHaveTextContent("40,000 sats");
    });

    // Flip to pickup — both totals drop ALL shipping (the Task #100 assertion).
    const pickupSubtitle = await screen.findByText(
      "Arrange pickup for products that offer it"
    );
    const pickupButton = pickupSubtitle.closest("button");
    expect(pickupButton).not.toBeNull();
    fireEvent.click(pickupButton as HTMLButtonElement);

    await waitFor(() => {
      expect(totalRow).toHaveTextContent("20.00 USD");
    });
    await waitFor(() => {
      expect(totalRow).toHaveTextContent("2,000 sats");
    });

    // Flip BACK to "Free or added shipping". The button carries the unique
    // subtitle below; click its enclosing <button>.
    const shippingSubtitle = await screen.findByText(
      "Arrange shipping for products that offer it"
    );
    const shippingButton = shippingSubtitle.closest("button");
    expect(shippingButton).not.toBeNull();
    fireEvent.click(shippingButton as HTMLButtonElement);

    // After switching back to shipping, BOTH totals must RE-ADD the "Added
    // Cost" product's shipping: fiat back to $20 items + $38 shipping = $58.00,
    // sats back to 2,000 items + 38,000 shipping = 40,000. A regression would
    // leave fiat at $20.00 and sats at 2,000 (shipping silently dropped).
    await waitFor(() => {
      expect(totalRow).toHaveTextContent("58.00 USD");
    });
    await waitFor(() => {
      expect(totalRow).toHaveTextContent("40,000 sats");
    });
    expect(totalRow.textContent ?? "").not.toMatch(/NaN/);

    // The card-payment button surfaces the same re-added-shipping fiat total.
    const cardButton = await screen.findByText(/Pay with Card:/);
    expect(cardButton).toHaveTextContent("58.00 USD");

    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});
