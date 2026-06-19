/**
 * @jest-environment jsdom
 *
 * Buyer-facing invoice card placeholder coverage.
 *
 * The Order Summary "Total" row in ProductInvoiceCard shows the native price
 * and, for non-sats currencies, an "≈ N sats" approximation derived from the
 * resilient FX helpers. Those helpers (getSatoshiValueResilient /
 * getFiatValueResilient) RETURN null — never throw — on a persistent
 * exchange-rate outage so the UI can degrade gracefully. Task #93 unit-tested
 * the helpers; this test guards the UI wiring: a null helper result must leave
 * the native price intact (no "NaN", no crash, no broken "≈" fragment), and a
 * real value must surface the approximation.
 */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

// Override ONLY the two resilient display helpers; keep every other currency
// export (formatWithCommas lives elsewhere, but isAtStripeFloor/applyStripeFloor
// etc. are pulled from here) real so the test exercises genuine rendering math.
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

// Heavy child components are irrelevant to the Order Summary total — stub them.
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

import ProductInvoiceCard from "@/components/product-invoice-card";
import type { ProductData } from "@/utils/parsers/product-parser-functions";

function buildProductData(overrides: Partial<ProductData> = {}): ProductData {
  return {
    id: "product-id",
    pubkey: "b".repeat(64),
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
    shippingType: "Free",
    ...overrides,
  } as ProductData;
}

const noopSetters = {
  setIsBeingPaid: jest.fn(),
  setFiatOrderIsPlaced: jest.fn(),
  setFiatOrderFailed: jest.fn(),
  setInvoiceIsPaid: jest.fn(),
  setInvoiceGenerationFailed: jest.fn(),
  setCashuPaymentSent: jest.fn(),
  setCashuPaymentFailed: jest.fn(),
};

function renderCard() {
  return render(
    <ProductInvoiceCard productData={buildProductData()} {...noopSetters} />
  );
}

beforeAll(() => {
  // checkSellerStripe() fetches on mount; return a benign non-merchant result.
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ hasStripeAccount: false, chargesEnabled: false }),
  })) as unknown as typeof fetch;
});

beforeEach(() => {
  getSatoshiValueResilientMock.mockReset();
  getFiatValueResilientMock.mockReset();
});

describe("ProductInvoiceCard FX-unavailable placeholder", () => {
  it("renders the native total without NaN or a broken approximation when the rate is unavailable", async () => {
    // Persistent outage: every resilient lookup yields null.
    getSatoshiValueResilientMock.mockResolvedValue(null);
    getFiatValueResilientMock.mockResolvedValue(null);

    renderCard();

    // The native USD total still renders.
    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;
    expect(totalRow).toHaveTextContent("10.00 USD");

    // Give the on-mount estimate effect a chance to resolve to null.
    await waitFor(() => {
      expect(getSatoshiValueResilientMock).toHaveBeenCalled();
    });

    // No NaN anywhere, and no dangling "≈" approximation fragment.
    expect(document.body.textContent).not.toMatch(/NaN/);
    expect(totalRow.textContent ?? "").not.toContain("≈");
  });

  it("shows the converted sats approximation when the rate is available", async () => {
    // Healthy feed: the discounted total converts to a concrete sats amount.
    getSatoshiValueResilientMock.mockResolvedValue(5000);
    getFiatValueResilientMock.mockResolvedValue(10);

    renderCard();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;
    expect(totalRow).toHaveTextContent("10.00 USD");

    // The "≈ 5,000 sats" approximation appears once the estimate resolves.
    await waitFor(() => {
      expect(totalRow.textContent ?? "").toContain("≈");
    });
    expect(totalRow).toHaveTextContent("5,000 sats");
    expect(document.body.textContent).not.toMatch(/NaN/);
  });
});
