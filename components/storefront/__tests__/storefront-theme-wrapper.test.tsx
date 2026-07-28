import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import StorefrontThemeWrapper from "../storefront-theme-wrapper";
import { ShopMapContext, ProfileMapContext } from "@/utils/context/context";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { usePublicMembershipStatus } from "@/utils/pro/use-public-membership";

jest.mock("next/router", () => ({
  useRouter: () => ({ push: jest.fn(), pathname: "/listing/abc", query: {} }),
}));

jest.mock("@/utils/pro/use-public-membership", () => ({
  usePublicMembershipStatus: jest.fn(),
}));

let mockIsCustomDomain = false;
jest.mock("@/utils/storefront/custom-domain-context", () => ({
  useIsCustomDomain: () => mockIsCustomDomain,
  applyCustomDomainHref: (href: string) => href,
}));

jest.mock("@/utils/storefront-cart", () => ({
  getStorefrontCartQuantity: jest.fn(() => 0),
}));

jest.mock("@heroui/react", () => ({
  useDisclosure: () => ({
    isOpen: false,
    onOpen: jest.fn(),
    onClose: jest.fn(),
  }),
}));

jest.mock(
  "../storefront-footer",
  () =>
    function MockFooter() {
      return <div data-testid="mock-storefront-footer" />;
    }
);
jest.mock(
  "../formatted-text",
  () =>
    function MockFormattedText({ text }: { text: string }) {
      return <span>{text}</span>;
    }
);
jest.mock("@/components/utility-components/profile/profile-dropdown", () => ({
  ProfileWithDropdown: () => <div data-testid="mock-profile-dropdown" />,
}));
jest.mock(
  "@/components/sign-in/SignInModal",
  () =>
    function MockSignInModal() {
      return <div data-testid="mock-signin-modal" />;
    }
);

const SELLER = "seller-pubkey-1";

const renderWrapper = ({
  isPro,
  hasStorefrontConfig,
}: {
  isPro: boolean;
  hasStorefrontConfig: boolean;
}) => {
  (usePublicMembershipStatus as jest.Mock).mockReturnValue({ isPro });

  const shopData = new Map<string, any>();
  shopData.set(SELLER, {
    content: {
      name: "Test Shop",
      about: "about",
      ui: { banner: "", picture: "" },
      ...(hasStorefrontConfig
        ? {
            storefront: {
              shopSlug: "test-shop",
              colorScheme: { primary: "#123456" },
            },
          }
        : {}),
    },
    event: { id: "evt" },
  });

  return render(
    <SignerContext.Provider value={{ isLoggedIn: false, pubkey: undefined }}>
      <ShopMapContext.Provider
        value={{ shopData, isLoading: false, updateShopData: jest.fn() }}
      >
        <ProfileMapContext.Provider
          value={{
            profileData: new Map(),
            isLoading: false,
            updateProfileData: jest.fn(),
          }}
        >
          <StorefrontThemeWrapper sellerPubkey={SELLER} renderChrome={true}>
            <div data-testid="page-content">product page</div>
          </StorefrontThemeWrapper>
        </ProfileMapContext.Provider>
      </ShopMapContext.Provider>
    </SignerContext.Provider>
  );
};

describe("StorefrontThemeWrapper platform-chrome preservation", () => {
  afterEach(() => {
    document.body.classList.remove("sf-active");
    document.body.style.removeProperty("--sf-bg");
    document.body.style.removeProperty("--sf-text");
    mockIsCustomDomain = false;
    jest.clearAllMocks();
  });

  it("does not set sf-active for a seller with no storefront config, so the Milk Market nav stays", async () => {
    renderWrapper({ isPro: true, hasStorefrontConfig: false });
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    // Give effects a chance to run
    await waitFor(() => {
      expect(usePublicMembershipStatus).toHaveBeenCalled();
    });
    expect(document.body.classList.contains("sf-active")).toBe(false);
  });

  it("does not set sf-active for a non-Pro seller even when a storefront config exists", async () => {
    renderWrapper({ isPro: false, hasStorefrontConfig: true });
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    await waitFor(() => {
      expect(usePublicMembershipStatus).toHaveBeenCalled();
    });
    expect(document.body.classList.contains("sf-active")).toBe(false);
    expect(
      screen.queryByTestId("mock-storefront-footer")
    ).not.toBeInTheDocument();
  });

  it("sets sf-active and renders seller chrome for a Pro seller with a storefront", async () => {
    renderWrapper({ isPro: true, hasStorefrontConfig: true });
    await waitFor(() => {
      expect(document.body.classList.contains("sf-active")).toBe(true);
    });
    expect(screen.getByTestId("mock-storefront-footer")).toBeInTheDocument();
  });

  it("keeps the eager neutral paint on custom domains while the storefront config loads", async () => {
    mockIsCustomDomain = true;
    renderWrapper({ isPro: true, hasStorefrontConfig: false });
    await waitFor(() => {
      expect(document.body.classList.contains("sf-active")).toBe(true);
    });
    expect(document.body.style.getPropertyValue("--sf-bg")).toBe("#FFFFFF");
    expect(document.body.style.getPropertyValue("--sf-text")).toBe("#000000");
  });

  it("removes sf-active again on unmount", async () => {
    const { unmount } = renderWrapper({
      isPro: true,
      hasStorefrontConfig: true,
    });
    await waitFor(() => {
      expect(document.body.classList.contains("sf-active")).toBe(true);
    });
    unmount();
    expect(document.body.classList.contains("sf-active")).toBe(false);
  });
});
