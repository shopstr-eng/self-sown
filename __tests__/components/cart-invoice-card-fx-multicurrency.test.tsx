/**
 * @jest-environment jsdom
 *
 * Buyer-facing MULTI-CURRENCY cart conversion coverage.
 *
 * CartInvoiceCard converts cross-currency line items and the grand total into
 * the cart's display currency via the resilient FX helpers
 * (getSatoshiValueResilient + getFiatValueResilient from utils/stripe/currency).
 * Two on-mount effects do this work for a NON-sats cart:
 *   - the `nativeTotalCost` effect (the grand total in cart-currency units), and
 *   - the `nativeCostsPerProduct` effect (each line in cart-currency units).
 * Both convert a foreign-currency line by first getting its satoshi value, then
 * the fiat value in the cart currency. On a persistent exchange-rate outage the
 * helpers RETURN null (never throw), and each effect has a documented
 * null-fallback branch: the per-product / per-line value falls back to the raw
 * amount and per-seller shipping falls back to 0, so a multi-currency cart never
 * renders a NaN or a crashed total — it degrades to the un-converted figure.
 *
 * Task #95 guarded the sats cart's card-button "≈ N USD" approximation. This
 * test guards the OTHER consumer of the resilient helpers: a USD cart that
 * contains a product priced in a different currency (EUR). With the helpers
 * mocked to null the native USD total must still render (no "NaN", no crash);
 * with real values the converted total must render normally.
 */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

// Override ONLY the two resilient display helpers; keep every other currency
// export (isSatsCurrency / applyStripeFloor / isAtStripeFloor / the Stripe
// constants the cart pulls from here) real so the test exercises genuine
// rendering math.
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
const EUR_PRODUCT_ID = "eur-product";

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
    shippingType: "Pickup",
    ...overrides,
  } as ProductData;
}

const noopSetters = {
  setInvoiceIsPaid: jest.fn(),
  setInvoiceGenerationFailed: jest.fn(),
  setCashuPaymentSent: jest.fn(),
  setCashuPaymentFailed: jest.fn(),
};

// A USD cart whose second line is priced in EUR. The cart currency resolves to
// USD (USD wins the tie-break in cartCurrency), so the EUR line is the only one
// that needs FX conversion — exercising BOTH resilient helpers
// (getSatoshiValueResilient: EUR→sats, then getFiatValueResilient: sats→USD).
function renderCart() {
  return render(
    <CartInvoiceCard
      products={[
        buildProduct(),
        buildProduct({
          id: EUR_PRODUCT_ID,
          title: "Imported Cheese",
          price: 20,
          currency: "EUR",
          totalCost: 20,
        }),
      ]}
      quantities={{ [USD_PRODUCT_ID]: 1, [EUR_PRODUCT_ID]: 1 }}
      // "Pickup" auto-selects the "contact" order type, which skips the address
      // form and renders the payment buttons (and Order Summary) immediately.
      shippingTypes={{ [USD_PRODUCT_ID]: "Pickup", [EUR_PRODUCT_ID]: "Pickup" }}
      totalCostsInSats={{ [USD_PRODUCT_ID]: 1000, [EUR_PRODUCT_ID]: 2000 }}
      subtotalCost={3000}
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

describe("CartInvoiceCard multi-currency FX conversion", () => {
  it("renders the native USD total without NaN or a crash when the rate is unavailable", async () => {
    // Persistent outage: every resilient lookup yields null. The EUR line then
    // falls back to its raw amount (20), so the documented graceful-degradation
    // total is the un-converted sum $10 + 20 = $30.00 — never NaN.
    getSatoshiValueResilientMock.mockResolvedValue(null);
    getFiatValueResilientMock.mockResolvedValue(null);

    renderCart();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;

    // The native USD total renders (raw-amount fallback) alongside the sats
    // approximation, with no NaN anywhere.
    await waitFor(() => {
      expect(totalRow).toHaveTextContent("30.00 USD");
    });
    expect(totalRow).toHaveTextContent("3,000 sats");
    expect(totalRow.textContent ?? "").not.toMatch(/NaN/);

    // The EUR cross-currency line exercised the sat-value helper. With it
    // returning null (outage), the component short-circuits the fiat leg —
    // there is no satoshi value to convert — so getFiatValueResilient is
    // deliberately NOT called on this path.
    await waitFor(() => {
      expect(getSatoshiValueResilientMock).toHaveBeenCalled();
    });
    expect(getFiatValueResilientMock).not.toHaveBeenCalled();

    // The card button surfaces the same native USD total — no NaN, no crash.
    const cardButton = await screen.findByText(/Pay with Card:/);
    expect(cardButton).toHaveTextContent("30.00 USD");

    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it("renders the converted USD total normally when the rate is available", async () => {
    // Healthy feed: the EUR line converts to sats (50,000) then to $15.00, so
    // the cart total is $10 + $15 = $25.00.
    getSatoshiValueResilientMock.mockResolvedValue(50000);
    getFiatValueResilientMock.mockResolvedValue(15);

    renderCart();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;

    await waitFor(() => {
      expect(totalRow).toHaveTextContent("25.00 USD");
    });
    expect(totalRow).toHaveTextContent("3,000 sats");

    const cardButton = await screen.findByText(/Pay with Card:/);
    expect(cardButton).toHaveTextContent("25.00 USD");

    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});
