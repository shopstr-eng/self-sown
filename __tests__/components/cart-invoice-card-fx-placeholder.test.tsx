/**
 * @jest-environment jsdom
 *
 * Buyer-facing multi-item cart checkout placeholder coverage.
 *
 * CartInvoiceCard mirrors ProductInvoiceCard's converted-price display: it
 * calls the resilient FX helpers (getSatoshiValueResilient /
 * getFiatValueResilient from utils/stripe/currency) to render approximate
 * conversions. For a sats-denominated cart the on-mount estimate effect derives
 * a USD approximation (usdEstimate) that surfaces on the card-payment button as
 * an "≈ N USD" fragment. Those helpers RETURN null — never throw — on a
 * persistent exchange-rate outage so the UI can degrade gracefully. Task #93
 * unit-tested the helpers and Task #94 guarded the single-product card; this
 * test guards the cart wiring: a null helper result must leave the native sats
 * totals intact (no "NaN", no crash, no dangling "≈"), and a real value must
 * surface the approximation.
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

// Heavy child components are irrelevant to the Order Summary / payment-button
// price display — stub them.
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
const PRODUCT_ID = "product-id";

function buildSatsProduct(overrides: Partial<ProductData> = {}): ProductData {
  return {
    id: PRODUCT_ID,
    pubkey: SELLER_PUBKEY,
    createdAt: 1710000000,
    title: "Raw Whole Milk",
    summary: "A gallon of fresh raw milk",
    publishedAt: "",
    images: ["https://example.com/milk.png"],
    categories: [],
    location: "",
    price: 5000,
    currency: "sats",
    totalCost: 5000,
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

function renderCart() {
  return render(
    <CartInvoiceCard
      products={[buildSatsProduct()]}
      quantities={{ [PRODUCT_ID]: 1 }}
      // "Pickup" auto-selects the "contact" order type, which skips the
      // address form and renders the payment buttons immediately.
      shippingTypes={{ [PRODUCT_ID]: "Pickup" }}
      totalCostsInSats={{ [PRODUCT_ID]: 5000 }}
      subtotalCost={5000}
      {...noopSetters}
    />
  );
}

beforeAll(() => {
  // The Stripe-merchant check fetches on mount; report the single seller as a
  // chargeable merchant so the card-payment button (which renders the USD
  // approximation) is present.
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

describe("CartInvoiceCard FX-unavailable placeholder", () => {
  it("renders native sats totals without NaN or a broken approximation when the rate is unavailable", async () => {
    // Persistent outage: every resilient lookup yields null.
    getSatoshiValueResilientMock.mockResolvedValue(null);
    getFiatValueResilientMock.mockResolvedValue(null);

    renderCart();

    // The native sats total still renders.
    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;
    expect(totalRow).toHaveTextContent("5,000 sats");

    // The card button surfaces once the Stripe-merchant check resolves; with a
    // null estimate it must show only the native sats amount — no "≈ USD".
    const cardButton = await screen.findByText(/Pay with Card:/);

    await waitFor(() => {
      expect(getSatoshiValueResilientMock).toHaveBeenCalled();
    });

    expect(cardButton).toHaveTextContent("5,000 sats");
    expect(cardButton.textContent ?? "").not.toContain("≈");
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it("shows the converted USD approximation on the card button when the rate is available", async () => {
    // Healthy feed: 5,000 sats per USD → the 5,000-sat cart estimates to $1.00.
    getSatoshiValueResilientMock.mockResolvedValue(5000);
    getFiatValueResilientMock.mockResolvedValue(1);

    renderCart();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;
    expect(totalRow).toHaveTextContent("5,000 sats");

    const cardButton = await screen.findByText(/Pay with Card:/);

    // The "≈ N USD" approximation appears once the estimate resolves.
    await waitFor(() => {
      expect(cardButton.textContent ?? "").toContain("≈");
    });
    expect(cardButton).toHaveTextContent("USD");
    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});
