/**
 * @jest-environment jsdom
 *
 * Single-product (buy-now) live USPS shipping coverage.
 *
 * The CART checkout (cart-invoice-card) quotes live USPS rates via Shippo and
 * verifies the buyer's address. This feature was ported into the SINGLE-PRODUCT
 * checkout (product-invoice-card) so direct "buy now" orders get the same live
 * rate + address correction. Both call host-independent endpoints
 * (/api/shipping/rates and /api/shipping/verify-address) that resolve the seller
 * from `sellerPubkey` in the request body, so they work on custom domains AND
 * the general marketplace.
 *
 * This test drives the real address form (react-hook-form) through real <input>
 * stubs and asserts:
 *   1. a successful live quote OVERRIDES the seller's static shipping cost in
 *      the Order Summary total,
 *   2. a quote failure FALLS BACK to the static cost (fail-safe, never NaN),
 *   3. a USPS address suggestion can be applied to the form fields.
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

// Keep the resilient FX helpers real; a USD product with USD shipping needs no
// conversion (shipCur === productCur short-circuits), so the math stays exact.
jest.mock("@/utils/stripe/currency", () => {
  const actual = jest.requireActual("@/utils/stripe/currency");
  return { ...actual };
});

// HeroUI stubs. Unlike the FX placeholder test we render a REAL <input> for
// `Input` so react-hook-form fields can actually be typed into and watched.
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
    const labelText = (label: unknown): string => {
      if (typeof label === "string") return label;
      const el = label as { props?: { children?: unknown } } | undefined;
      const child = el?.props?.children;
      return typeof child === "string" ? child : "";
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
      Input: ({
        label,
        value,
        onChange,
        onBlur,
      }: {
        label?: unknown;
        value?: string;
        onChange?: (e: unknown) => void;
        onBlur?: (e: unknown) => void;
      }) => (
        <input
          aria-label={labelText(label)}
          value={value || ""}
          onChange={onChange}
          onBlur={onBlur}
        />
      ),
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

// Heavy / irrelevant children.
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
jest.mock("@/components/utility-components/address-picker", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/sign-in/SignInModal", () => ({
  __esModule: true,
  default: () => null,
}));

// Real Country control so the US-only gate can be satisfied. The real dropdown
// calls onChange with the selected value; react-hook-form accepts a raw value.
jest.mock("@/components/utility-components/dropdowns/country-dropdown", () => ({
  __esModule: true,
  default: ({
    value,
    onChange,
  }: {
    value?: string;
    onChange?: (v: string) => void;
  }) => (
    <input
      aria-label="Country"
      value={value || ""}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

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

const SELLER_PUBKEY = "b".repeat(64);

// A $10 USD product whose seller charges a $5 static shipping cost but supplies
// the origin zip + parcel weight that make it eligible for a live USPS quote.
function buildProduct(overrides: Partial<ProductData> = {}): ProductData {
  return {
    id: "product-id",
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
    shippingType: "Added Cost",
    shippingCost: 5,
    shippingCurrency: "USD",
    shipFromZip: "90210",
    shipFromCountry: "US",
    packageWeightOz: 16,
    packageLengthIn: 6,
    packageWidthIn: 4,
    packageHeightIn: 4,
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

// Per-test endpoint responders, swapped before each render.
let ratesResponder: () => unknown;
let verifyResponder: () => unknown;

beforeEach(() => {
  // Defaults: verified (unchanged) address + a $12 live USPS quote.
  verifyResponder = () => ({
    success: true,
    valid: true,
    street1: "123 Main St",
    street2: "",
    city: "Springfield",
    state: "IL",
    zip: "62704",
    country: "US",
    messages: [],
  });
  ratesResponder = () => ({
    success: true,
    shipmentId: "shp_test",
    cheapest: {
      rate: 12,
      id: "rate_test",
      service: "Priority",
      carrier: "USPS",
    },
  });

  global.fetch = jest.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("/api/shipping/verify-address")) {
      return { ok: true, json: async () => verifyResponder() };
    }
    if (u.includes("/api/shipping/rates")) {
      return { ok: true, json: async () => ratesResponder() };
    }
    // checkSellerStripe + connected-account + anything else on mount.
    return {
      ok: true,
      json: async () => ({ hasStripeAccount: false, chargesEnabled: false }),
    };
  }) as unknown as typeof fetch;
});

function renderCard(overrides: Partial<ProductData> = {}) {
  return render(
    <ProductInvoiceCard
      productData={buildProduct(overrides)}
      {...noopSetters}
    />
  );
}

// Fill the four text fields + Country so both shipping effects become eligible.
async function fillUsAddress() {
  const address = await screen.findByLabelText("Address");
  fireEvent.change(address, { target: { value: "123 Main St" } });
  fireEvent.change(screen.getByLabelText("City"), {
    target: { value: "Springfield" },
  });
  fireEvent.change(screen.getByLabelText("State/Province"), {
    target: { value: "IL" },
  });
  fireEvent.change(screen.getByLabelText("Postal code"), {
    target: { value: "62704" },
  });
  fireEvent.change(screen.getByLabelText("Country"), {
    target: { value: "US" },
  });
}

describe("ProductInvoiceCard live USPS shipping", () => {
  it("overrides the seller's static shipping cost with the live USPS quote", async () => {
    renderCard();
    await fillUsAddress();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;

    // $10 item + $12 LIVE shipping = $22.00 (NOT the $15.00 static fallback).
    await waitFor(
      () => {
        expect(totalRow).toHaveTextContent("22.00 USD");
      },
      { timeout: 4000 }
    );
    expect(totalRow.textContent ?? "").not.toMatch(/NaN/);

    // The rate endpoint was called with USPS + the seller's pubkey (host-
    // independent resolution), proving it works off-domain too.
    const rateCall = (global.fetch as jest.Mock).mock.calls.find((c) =>
      String(c[0]).includes("/api/shipping/rates")
    );
    expect(rateCall).toBeTruthy();
    const body = JSON.parse((rateCall![1] as RequestInit).body as string);
    expect(body.sellerPubkey).toBe(SELLER_PUBKEY);
    expect(body.carriers).toEqual(["USPS"]);
    expect(body.parcel.weightOz).toBe(16);
  });

  it("falls back to the static shipping cost when the live quote fails", async () => {
    ratesResponder = () => ({ success: false });
    renderCard();
    await fillUsAddress();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;

    // Quote failed → keep the $5 static cost: $10 + $5 = $15.00, never NaN.
    await waitFor(
      () => {
        expect(global.fetch as jest.Mock).toHaveBeenCalled();
      },
      { timeout: 4000 }
    );
    await waitFor(
      () => {
        expect(totalRow).toHaveTextContent("15.00 USD");
      },
      { timeout: 4000 }
    );
    expect(totalRow.textContent ?? "").not.toMatch(/NaN/);
    expect(totalRow.textContent ?? "").not.toMatch(/22\.00/);
  });

  it("applies a USPS address suggestion to the form fields", async () => {
    // USPS returns a corrected city; the component should offer the suggestion.
    verifyResponder = () => ({
      success: true,
      valid: true,
      street1: "123 Main St",
      street2: "",
      city: "Springfield City",
      state: "IL",
      zip: "62704",
      country: "US",
      messages: [],
    });

    renderCard();
    await fillUsAddress();

    const useSuggested = await screen.findByText("Use suggested address", {
      exact: false,
    });
    fireEvent.click(useSuggested);

    // The City field is rewritten to the USPS-suggested value.
    await waitFor(() => {
      expect(screen.getByLabelText("City")).toHaveValue("Springfield City");
    });
  });

  it("drops a stale quote immediately when the address changes (no stale charge)", async () => {
    renderCard();
    await fillUsAddress();

    const totalLabel = await screen.findByText("Total:");
    const totalRow = totalLabel.parentElement as HTMLElement;

    // First destination gets the $12 live quote → $22 total.
    await waitFor(() => expect(totalRow).toHaveTextContent("22.00 USD"), {
      timeout: 4000,
    });

    // The buyer edits the destination. The stale $12 quote was fetched for the
    // PREVIOUS address, so it must stop counting the INSTANT the address
    // changes — not only after the new quote resolves. fireEvent flushes
    // effects via act(), and for a same-currency order convertedShippingCost is
    // recomputed synchronously, so the total reverts to the static $5 cost
    // ($15) immediately, with NO network/debounce wait. This is the money-safety
    // guarantee: there is no frame where the old quote can still be charged.
    ratesResponder = () => ({ success: false });
    fireEvent.change(screen.getByLabelText("City"), {
      target: { value: "Capital City" },
    });

    expect(totalRow.textContent ?? "").not.toMatch(/22\.00/);
    expect(totalRow).toHaveTextContent("15.00 USD");

    // And it stays on the static cost after the (failed) re-quote settles.
    await waitFor(() => expect(totalRow).toHaveTextContent("15.00 USD"), {
      timeout: 4000,
    });
    expect(totalRow.textContent ?? "").not.toMatch(/22\.00/);
  });

  it("clears the live quote and spinner when the address becomes ineligible", async () => {
    renderCard();
    await fillUsAddress();

    // Live quote applied for the eligible US address.
    expect(
      await screen.findByText("Live USPS shipping rate applied.")
    ).toBeInTheDocument();

    // Switch to a non-US country — live USPS quoting no longer applies.
    fireEvent.change(screen.getByLabelText("Country"), {
      target: { value: "CA" },
    });

    // Both the "applied" badge and the calculating spinner disappear, and the
    // total falls back to the seller's static $5 cost ($15) — no stuck spinner,
    // no lingering live rate.
    await waitFor(() => {
      expect(
        screen.queryByText("Live USPS shipping rate applied.")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Calculating live USPS shipping rate…")
      ).not.toBeInTheDocument();
    });

    const totalRow = (await screen.findByText("Total:"))
      .parentElement as HTMLElement;
    await waitFor(() => expect(totalRow).toHaveTextContent("15.00 USD"), {
      timeout: 4000,
    });
  });
});
