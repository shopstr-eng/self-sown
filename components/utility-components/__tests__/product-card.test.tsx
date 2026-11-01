import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ProductCard from "../product-card";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { ProductData } from "@/utils/parsers/product-parser-functions";
import { resetLiveStockCacheForTests } from "@/utils/hooks/use-live-stock";

const mockRouter = {
  pathname: "/product-page",
  push: jest.fn(),
};
jest.mock("next/router", () => ({
  useRouter: () => mockRouter,
}));

jest.mock("../profile/profile-dropdown", () => ({
  ProfileWithDropdown: (props: any) => (
    <div
      data-testid="profile-dropdown"
      data-pubkey={props.pubkey}
      data-keys={JSON.stringify(props.dropDownKeys)}
    >
      <button data-testid="profile-dropdown-trigger">Seller</button>
    </div>
  ),
}));
jest.mock(
  "../image-carousel",
  () =>
    function MockImageCarousel(_props: any) {
      return <div data-testid="image-carousel" />;
    }
);
jest.mock("../display-monetary-info", () => ({
  __esModule: true,
  default: (_props: any) => <div data-testid="compact-price-display" />,
}));
jest.mock("../dropdowns/location-dropdown", () => ({
  locationAvatar: (location: string) => <div>{`Avatar for ${location}`}</div>,
}));

jest.mock("@heroui/react", () => ({
  ...jest.requireActual("@heroui/react"),
  Chip: ({ children, startContent }: any) => (
    <div>
      {startContent}
      {children}
    </div>
  ),
  useDisclosure: () => ({
    isOpen: false,
    onOpen: jest.fn(),
    onClose: jest.fn(),
  }),
}));

const mockProductData: ProductData = {
  id: "123",
  pubkey: "owner_pubkey",
  title: "Test Product",
  summary: "A great product summary.",
  images: ["image1.jpg"],
  categories: ["Electronics"],
  location: "Online",
  price: 1000,
  currency: "SATS",
  shippingType: "Free",
  status: "active",
  createdAt: 0,
  publishedAt: "",
  totalCost: 1000,
};

const mockSellerZapsnagProduct: ProductData = {
  ...mockProductData,
  d: "zapsnag",
  categories: ["zapsnag"],
};

const renderWithContext = (
  ui: React.ReactElement,
  userPubkey: string | null = null
) => {
  return render(
    <SignerContext.Provider
      value={{ pubkey: userPubkey, setPubkey: jest.fn() } as any}
    >
      {ui}
    </SignerContext.Provider>
  );
};

describe("ProductCard", () => {
  beforeEach(() => {
    mockRouter.push.mockClear();
  });

  it("returns null if no productData is provided", () => {
    // @ts-expect-error: Intentionally passing null to test component's null-handling
    const { container } = render(<ProductCard productData={null} />);
    expect(container.firstChild).toBeNull();
  });

  describe("Standard View", () => {
    it("renders the standard card layout", () => {
      renderWithContext(<ProductCard productData={mockProductData} />);
      expect(screen.getByTestId("image-carousel")).toBeInTheDocument();
      expect(screen.getByTestId("profile-dropdown")).toBeInTheDocument();
      expect(screen.getByText("Test Product")).toBeInTheDocument();
    });

    it("calls onProductClick when the card is clicked", () => {
      const mockOnClick = jest.fn();
      renderWithContext(
        <ProductCard
          productData={mockProductData}
          onProductClick={mockOnClick}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /test product/i }));
      expect(mockOnClick).toHaveBeenCalledWith(
        mockProductData,
        expect.any(Object)
      );
    });

    it("navigates via router.push when href is provided", () => {
      renderWithContext(
        <ProductCard productData={mockProductData} href="/listing/test-slug" />
      );

      fireEvent.click(screen.getByRole("link"));
      expect(mockRouter.push).toHaveBeenCalledWith("/listing/test-slug");
    });

    it("navigates when pressing Enter on the linked card itself", () => {
      renderWithContext(
        <ProductCard productData={mockProductData} href="/listing/test-slug" />
      );

      fireEvent.keyDown(screen.getByRole("link"), { key: "Enter" });
      expect(mockRouter.push).toHaveBeenCalledWith("/listing/test-slug");
    });

    it("does not navigate when clicking seller dropdown area", () => {
      renderWithContext(
        <ProductCard productData={mockProductData} href="/listing/test-slug" />
      );

      fireEvent.click(screen.getByTestId("profile-dropdown-trigger"));
      expect(mockRouter.push).not.toHaveBeenCalled();
    });

    it("does not navigate if onProductClick prevents default", () => {
      const onProductClick = jest.fn((_product, event) =>
        event?.preventDefault()
      );

      renderWithContext(
        <ProductCard
          productData={mockProductData}
          href="/listing/test-slug"
          onProductClick={onProductClick}
        />
      );

      fireEvent.click(screen.getByRole("link"));
      expect(onProductClick).toHaveBeenCalled();
      expect(mockRouter.push).not.toHaveBeenCalled();
    });

    it("does not navigate when pressing Enter on nested controls inside a linked seller card", () => {
      renderWithContext(
        <ProductCard
          productData={mockSellerZapsnagProduct}
          href="/listing/test-slug"
        />,
        "owner_pubkey"
      );

      fireEvent.keyDown(
        screen.getByRole("button", {
          name: /open flash sale in nostr client/i,
        }),
        { key: "Enter" }
      );

      expect(mockRouter.push).not.toHaveBeenCalled();
    });

    it('shows "shop_profile" dropdown key for the owner', () => {
      renderWithContext(
        <ProductCard productData={mockProductData} />,
        "owner_pubkey"
      );
      const dropdown = screen.getByTestId("profile-dropdown");
      const keys = JSON.parse(dropdown.getAttribute("data-keys")!);
      expect(keys).toEqual(["shop_profile"]);
    });

    it("shows correct dropdown keys for a non-owner", () => {
      renderWithContext(
        <ProductCard productData={mockProductData} />,
        "other_user_pubkey"
      );
      const dropdown = screen.getByTestId("profile-dropdown");
      const keys = JSON.parse(dropdown.getAttribute("data-keys")!);
      expect(keys).toEqual(["shop", "inquiry", "copy_npub", "report_profile"]);
    });

    it("shows sold status correctly", () => {
      renderWithContext(
        <ProductCard productData={{ ...mockProductData, status: "sold" }} />
      );
      expect(screen.getByText("Sold")).toBeInTheDocument();
    });
  });
});

describe("ProductCard stock hints", () => {
  const LISTED_AT = 1_700_000_000;
  const fetchMock = jest.fn();

  // The router mock reports "/product-page", so the details block renders.
  const stocked = (overrides: Partial<ProductData> = {}): ProductData => ({
    ...mockProductData,
    createdAt: LISTED_AT,
    ...overrides,
  });

  const answerWith = (stock: Record<string, unknown>) =>
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, stock }),
    });

  beforeEach(() => {
    resetLiveStockCacheForTests();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, stock: {} }),
    });
    (global as any).fetch = fetchMock;
  });

  it("shows nothing for a product with no quantity", async () => {
    renderWithContext(<ProductCard productData={stocked()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/sold out here/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/left/i)).not.toBeInTheDocument();
  });

  it("shows 'Sold out here' when newer local stock is zero", async () => {
    answerWith({
      "123": {
        default_quantity: 0,
        variants: {},
        default_updated_at: LISTED_AT + 60,
      },
    });
    renderWithContext(<ProductCard productData={stocked({ quantity: 10 })} />);
    expect(await screen.findByText("Sold out here")).toBeInTheDocument();
  });

  it("shows 'Only N left' when newer local stock is low", async () => {
    answerWith({
      "123": {
        default_quantity: 3,
        variants: {},
        default_updated_at: LISTED_AT + 60,
      },
    });
    renderWithContext(<ProductCard productData={stocked({ quantity: 10 })} />);
    expect(await screen.findByText("Only 3 left")).toBeInTheDocument();
  });

  it("ignores local stock that is older than the listing", async () => {
    answerWith({
      "123": {
        default_quantity: 0,
        variants: {},
        default_updated_at: LISTED_AT - 60,
      },
    });
    renderWithContext(<ProductCard productData={stocked({ quantity: 10 })} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText("Sold out here")).not.toBeInTheDocument();
  });

  it("uses the listing's own quantity when the lookup fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    renderWithContext(<ProductCard productData={stocked({ quantity: 2 })} />);
    expect(await screen.findByText("Only 2 left")).toBeInTheDocument();
  });

  it("shows 'Sold out here' when every size is empty", async () => {
    answerWith({
      "123": {
        default_quantity: null,
        variants: { "size:S": 0, "size:M": 0 },
        variant_updated_at: {
          "size:S": LISTED_AT + 1,
          "size:M": LISTED_AT + 1,
        },
      },
    });
    renderWithContext(
      <ProductCard
        productData={stocked({
          sizes: ["S", "M"],
          sizeQuantities: new Map([
            ["S", 4],
            ["M", 4],
          ]),
        })}
      />
    );
    expect(await screen.findByText("Sold out here")).toBeInTheDocument();
  });

  it("leaves a listing the seller marked sold on the existing 'Sold' chip", async () => {
    answerWith({
      "123": {
        default_quantity: 0,
        variants: {},
        default_updated_at: LISTED_AT + 60,
      },
    });
    renderWithContext(
      <ProductCard productData={stocked({ status: "sold", quantity: 5 })} />
    );
    expect(screen.getByText("Sold")).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText("Sold out here")).not.toBeInTheDocument();
  });

  it("does not add stock chips to flash sales", async () => {
    answerWith({
      "123": {
        default_quantity: 0,
        variants: {},
        default_updated_at: LISTED_AT + 60,
      },
    });
    renderWithContext(
      <ProductCard
        productData={{ ...mockSellerZapsnagProduct, createdAt: LISTED_AT }}
      />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText("Sold out here")).not.toBeInTheDocument();
  });
});
