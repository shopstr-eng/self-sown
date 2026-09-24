import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import StorefrontThemeWrapper from "../storefront-theme-wrapper";
import { ShopMapContext, ProfileMapContext } from "@/utils/context/context";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { resetPublicMembershipCache } from "@/utils/pro/use-public-membership";
import type { MembershipView } from "@/utils/pro/constants";

// NOTE: unlike storefront-theme-wrapper.test.tsx, this suite deliberately does
// NOT mock @/utils/pro/use-public-membership — it exercises the real resolver
// against a mocked /api/pro/status fetch to prove chrome survives a transient
// status outage and is still stripped on a definitive non-Pro answer.

jest.mock("next/router", () => ({
  useRouter: () => ({ push: jest.fn(), pathname: "/listing/abc", query: {} }),
}));

jest.mock("@/utils/storefront/custom-domain-context", () => ({
  useIsCustomDomain: () => false,
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

const SELLER = "c".repeat(64);

const proView = (pubkey: string, isPro: boolean): MembershipView => ({
  pubkey,
  status: isPro ? "active" : "free",
  isPro,
  canEdit: isPro,
  isTrialing: false,
  isReadOnly: false,
  isHidden: false,
  isPubliclyVisible: true,
  isLifetime: false,
  billingMethod: null,
  term: null,
  trialEnd: null,
  currentPeriodEnd: null,
  graceUntil: null,
  readonlyUntil: null,
  cancelAtPeriodEnd: false,
});

const okResponse = (pubkey: string, isPro: boolean) =>
  ({ ok: true, json: async () => proView(pubkey, isPro) }) as Response;
const errorResponse = () =>
  ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response;

let fetchMock: jest.Mock;

const SELLER_B = "d".repeat(64);

const renderWrapper = ({ sellerPubkey = SELLER } = {}) => {
  const shopData = new Map<string, any>();
  for (const pk of [SELLER, SELLER_B]) {
    shopData.set(pk, {
      content: {
        name: "Test Shop",
        about: "about",
        ui: { banner: "", picture: "" },
        storefront: {
          shopSlug: "test-shop",
          colorScheme: { primary: "#123456" },
        },
      },
      event: { id: "evt" },
    });
  }

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
          <StorefrontThemeWrapper
            sellerPubkey={sellerPubkey}
            renderChrome={true}
          >
            <div data-testid="page-content">product page</div>
          </StorefrontThemeWrapper>
        </ProfileMapContext.Provider>
      </ShopMapContext.Provider>
    </SignerContext.Provider>
  );
};

describe("StorefrontThemeWrapper pro-status outage resilience", () => {
  beforeEach(() => {
    localStorage.clear();
    resetPublicMembershipCache();
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    document.body.classList.remove("sf-active");
    document.body.style.removeProperty("--sf-bg");
    document.body.style.removeProperty("--sf-text");
  });

  it("keeps seller chrome (fonts/colors/footer) on wrapped routes when the status check terminally fails", async () => {
    // Establish last-known-good: seller verified Pro while the endpoint is up.
    fetchMock.mockResolvedValue(okResponse(SELLER, true));
    const first = renderWrapper();
    await waitFor(() => {
      expect(screen.getByTestId("mock-storefront-footer")).toBeInTheDocument();
    });
    expect(document.body.classList.contains("sf-active")).toBe(true);
    first.unmount();
    document.body.classList.remove("sf-active");
    resetPublicMembershipCache();

    // Status endpoint is now down (DB outage): every attempt 500s.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(errorResponse());
    renderWrapper();
    // The themed chrome must survive the outage on this wrapped route.
    await waitFor(
      () => {
        expect(
          screen.getByTestId("mock-storefront-footer")
        ).toBeInTheDocument();
        expect(document.body.classList.contains("sf-active")).toBe(true);
      },
      { timeout: 10000 }
    );
    // Bounded retry: the resolver gives up after a fixed number of attempts
    // and keeps the last-known-good view instead of stripping chrome.
    await waitFor(
      () => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3),
      { timeout: 10000 }
    );
    expect(screen.getByTestId("mock-storefront-footer")).toBeInTheDocument();
  }, 20000);

  it("never applies seller A's chrome to seller B across a client-side switch", async () => {
    // Seller A is verified Pro and gets their themed chrome.
    fetchMock.mockResolvedValue(okResponse(SELLER, true));
    const view = render(
      <SignerContext.Provider value={{ isLoggedIn: false, pubkey: undefined }}>
        <ShopMapContext.Provider
          value={{
            shopData: (() => {
              const m = new Map<string, any>();
              for (const pk of [SELLER, SELLER_B]) {
                m.set(pk, {
                  content: {
                    name: "Test Shop",
                    about: "about",
                    ui: { banner: "", picture: "" },
                    storefront: {
                      shopSlug: "test-shop",
                      colorScheme: { primary: "#123456" },
                    },
                  },
                  event: { id: "evt" },
                });
              }
              return m;
            })(),
            isLoading: false,
            updateShopData: jest.fn(),
          }}
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
    await waitFor(() => {
      expect(screen.getByTestId("mock-storefront-footer")).toBeInTheDocument();
    });

    // Client-side switch to seller B: no cache for B, endpoint down, so B's
    // lookup only resolves after the full retry window. Seller A's entitlement
    // must never paint B's chrome in the meantime.
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error("network down"));
    const shopData = new Map<string, any>();
    for (const pk of [SELLER, SELLER_B]) {
      shopData.set(pk, {
        content: {
          name: "Test Shop",
          about: "about",
          ui: { banner: "", picture: "" },
          storefront: {
            shopSlug: "test-shop",
            colorScheme: { primary: "#123456" },
          },
        },
        event: { id: "evt" },
      });
    }
    view.rerender(
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
            <StorefrontThemeWrapper sellerPubkey={SELLER_B} renderChrome={true}>
              <div data-testid="page-content">product page</div>
            </StorefrontThemeWrapper>
          </ProfileMapContext.Provider>
        </ShopMapContext.Provider>
      </SignerContext.Provider>
    );

    // Immediately after the switch: no chrome for B.
    expect(
      screen.queryByTestId("mock-storefront-footer")
    ).not.toBeInTheDocument();
    // And it must still be absent after B's lookup terminally fails.
    await waitFor(
      () => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3),
      { timeout: 10000 }
    );
    expect(
      screen.queryByTestId("mock-storefront-footer")
    ).not.toBeInTheDocument();
    expect(document.body.classList.contains("sf-active")).toBe(false);
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
  }, 20000);

  it("still strips chrome on a definitive 200 + isPro:false even with a stale cached entitlement", async () => {
    // Seller was Pro at last check but has since lapsed.
    fetchMock.mockResolvedValue(okResponse(SELLER, true));
    const first = renderWrapper();
    await waitFor(() => {
      expect(screen.getByTestId("mock-storefront-footer")).toBeInTheDocument();
    });
    first.unmount();
    document.body.classList.remove("sf-active");
    resetPublicMembershipCache();

    // Endpoint reachable again and definitively says: not Pro.
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(okResponse(SELLER, false));
    renderWrapper();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("mock-storefront-footer")
      ).not.toBeInTheDocument();
      expect(document.body.classList.contains("sf-active")).toBe(false);
    });
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
  }, 15000);
});
