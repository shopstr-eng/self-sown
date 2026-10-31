import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import CheckoutCard from "../checkout-card";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import type { ProductData } from "@/utils/parsers/product-parser-functions";
import { resetLiveStockCacheForTests } from "@/utils/hooks/use-live-stock";

const mockRouter = { pathname: "/listing", push: jest.fn(), query: {} };
jest.mock("next/router", () => ({ useRouter: () => mockRouter }));

jest.mock("@heroui/react", () => ({
  ...jest.requireActual("@heroui/react"),
  useDisclosure: () => ({
    isOpen: false,
    onOpen: jest.fn(),
    onClose: jest.fn(),
  }),
}));
jest.mock("../profile/profile-dropdown", () => ({
  ProfileWithDropdown: () => <div data-testid="profile-dropdown" />,
}));
jest.mock("../display-monetary-info", () => ({
  __esModule: true,
  default: () => <div />,
  DisplayCheckoutCost: () => <div data-testid="checkout-cost" />,
}));
jest.mock("../../product-invoice-card", () => ({
  __esModule: true,
  default: () => <div data-testid="invoice-card" />,
}));
jest.mock("../../sign-in/SignInModal", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../beef-initiative-badge", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../dropdowns/location-dropdown", () => ({
  locationAvatar: () => null,
}));
jest.mock("@/utils/storefront/seller-share-url", () => ({
  getCachedSellerCustomDomainBaseUrl: jest.fn(),
  prefetchSellerCustomDomainBaseUrl: jest.fn(),
  shareProductUrl: jest.fn(),
}));
const mockZapsnagButton = jest.fn((_props: any) => (
  <div data-testid="zapsnag-button" />
));
jest.mock("@/components/ZapsnagButton", () => ({
  __esModule: true,
  default: (props: any) => mockZapsnagButton(props),
}));

const LISTED_AT = 1_700_000_000;
const fetchMock = jest.fn();

const baseProduct: ProductData = {
  id: "evt-1",
  pubkey: "seller_pubkey",
  title: "Raw Milk",
  summary: "Fresh from the farm",
  images: ["milk.jpg"],
  categories: ["milk"],
  location: "Vermont",
  price: 12,
  currency: "USD",
  shippingType: "N/A",
  status: "active",
  createdAt: LISTED_AT,
  publishedAt: "",
  totalCost: 12,
};

const answerWith = (stock: Record<string, unknown>) =>
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, stock }),
  });

const renderCard = (productData: ProductData) =>
  render(
    <SignerContext.Provider
      value={{ pubkey: "buyer_pubkey", isLoggedIn: true } as any}
    >
      <CheckoutCard
        productData={productData}
        setFiatOrderIsPlaced={jest.fn()}
        setFiatOrderFailed={jest.fn()}
        setInvoiceIsPaid={jest.fn()}
        setInvoiceGenerationFailed={jest.fn()}
        setCashuPaymentSent={jest.fn()}
        setCashuPaymentFailed={jest.fn()}
      />
    </SignerContext.Provider>
  );

beforeEach(() => {
  resetLiveStockCacheForTests();
  mockZapsnagButton.mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, stock: {} }),
  });
  (global as any).fetch = fetchMock;
});

describe("CheckoutCard live stock", () => {
  it("offers Buy Now and Add To Cart while stock is available", async () => {
    renderCard({ ...baseProduct, quantity: 10 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /buy now/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /add to cart/i })).toBeEnabled();
    expect(screen.queryByText(/sold out/i)).not.toBeInTheDocument();
  });

  it("replaces the buttons with 'Sold Out Here' when newer local stock is zero", async () => {
    answerWith({
      "evt-1": {
        default_quantity: 0,
        variants: {},
        default_updated_at: LISTED_AT + 60,
      },
    });
    renderCard({ ...baseProduct, quantity: 10 });

    expect(
      await screen.findByRole("button", { name: "Sold Out Here" })
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /buy now/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /add to cart/i })
    ).not.toBeInTheDocument();
  });

  it("keeps selling when the stock row is older than the listing", async () => {
    answerWith({
      "evt-1": {
        default_quantity: 0,
        variants: {},
        default_updated_at: LISTED_AT - 60,
      },
    });
    renderCard({ ...baseProduct, quantity: 10 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /buy now/i })).toBeEnabled();
  });

  it("shows 'Only N left' when stock is low", async () => {
    answerWith({
      "evt-1": {
        default_quantity: 2,
        variants: {},
        default_updated_at: LISTED_AT + 60,
      },
    });
    renderCard({ ...baseProduct, quantity: 10 });
    expect(await screen.findByText("Only 2 left")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /buy now/i })).toBeEnabled();
  });

  it("is sold out when every size has sold out, instead of selling with no size", async () => {
    answerWith({
      "evt-1": {
        default_quantity: null,
        variants: { "size:S": 0, "size:M": 0 },
        variant_updated_at: {
          "size:S": LISTED_AT + 1,
          "size:M": LISTED_AT + 1,
        },
      },
    });
    renderCard({
      ...baseProduct,
      sizes: ["S", "M"],
      sizeQuantities: new Map([
        ["S", 3],
        ["M", 3],
      ]),
    });
    expect(
      await screen.findByRole("button", { name: "Sold Out Here" })
    ).toBeInTheDocument();
  });

  it("hides only the sizes that sold out", async () => {
    answerWith({
      "evt-1": {
        default_quantity: null,
        variants: { "size:S": 0 },
        variant_updated_at: { "size:S": LISTED_AT + 1 },
      },
    });
    renderCard({
      ...baseProduct,
      sizes: ["S", "M"],
      sizeQuantities: new Map([
        ["S", 3],
        ["M", 3],
      ]),
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "S" })
      ).not.toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: "M" })).toBeInTheDocument();
  });

  it("uses the listing's own quantity when the lookup fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    renderCard({ ...baseProduct, quantity: 0 });
    expect(
      await screen.findByRole("button", { name: "Sold Out Here" })
    ).toBeInTheDocument();
  });

  it("keeps the plain 'Sold Out' button for a listing marked sold", async () => {
    renderCard({ ...baseProduct, status: "sold", quantity: 5 });
    expect(
      await screen.findByRole("button", { name: "Sold Out" })
    ).toBeInTheDocument();
  });

  it("gives flash sales the original listing, not the adjusted quantity", async () => {
    answerWith({
      "evt-1": {
        default_quantity: 0,
        variants: {},
        default_updated_at: LISTED_AT + 60,
      },
    });
    renderCard({
      ...baseProduct,
      d: "zapsnag",
      categories: ["zapsnag"],
      quantity: 10,
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId("zapsnag-button")).toBeInTheDocument();
    for (const [props] of mockZapsnagButton.mock.calls) {
      expect(props.product.quantity).toBe(10);
    }
  });
});
