import React from "react";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import ShopProfileForm from "../shop-profile-form";
import { ShopMapContext } from "@/utils/context/context";
import {
  SignerContext,
  NostrContext,
} from "@/components/utility-components/nostr-context-provider";
import { createNostrShopEvent } from "@/utils/nostr/nostr-helper-functions";

const mockRouterPush = jest.fn();
jest.mock("next/router", () => ({
  useRouter: jest.fn(() => ({ push: mockRouterPush })),
}));

jest.mock("@/utils/nostr/nostr-helper-functions", () => ({
  createNostrShopEvent: jest.fn(),
}));
const mockCreateNostrShopEvent = createNostrShopEvent as jest.Mock;

jest.mock("@/components/utility-components/file-uploader", () => ({
  FileUploaderButton: jest.fn(
    ({ children, imgCallbackOnUpload, isIconOnly }) => (
      <button
        data-testid={isIconOnly ? "upload-picture-btn" : "upload-banner-btn"}
        onClick={() => imgCallbackOnUpload("https://new.image/url")}
      >
        {children}
      </button>
    )
  ),
}));

jest.mock("@/components/utility-components/ss-spinner", () => () => null);

jest.mock("../storefront/storefront-preview-panel", () => () => null);

// Mutable so individual tests can open the AdvancedStorefrontGate (the
// assistant-visibility toggles only render for Pro sellers).
let mockMembership = { isPro: false, isReadOnly: false };
jest.mock("@/components/utility-components/pro-membership-context", () => ({
  useProMembership: () => ({
    membership: mockMembership,
    isPro: mockMembership.isPro,
    loading: false,
  }),
}));

// Heavy storefront editors that mount inside the advanced (Pro) gate. The
// hydration tests below open that gate, so stub these to keep the render
// focused on the form's own state.
jest.mock("../custom-domain-section", () => () => null);
jest.mock("../storefront/page-editor", () => () => null);
jest.mock("../storefront/footer-editor", () => () => null);
jest.mock("../storefront/section-editor", () => () => null);
jest.mock("../storefront/storefront-preview-modal", () => () => null);

const mockUserPubkey = "test_pubkey";
const mockShopData = new Map([
  [
    mockUserPubkey,
    {
      pubkey: mockUserPubkey,
      content: {
        name: "My Awesome Shop",
        about: "The best shop ever.",
        ui: {
          picture: "https://existing.image/picture.png",
          banner: "https://existing.image/banner.png",
        },
      },
    },
  ],
]);

const renderWithProviders = (
  component: React.ReactElement,
  shopData = new Map()
) => {
  const mockUpdateShopData = jest.fn();
  render(
    <NostrContext.Provider value={{ nostr: {} as any }}>
      <SignerContext.Provider
        value={{ signer: {} as any, pubkey: mockUserPubkey }}
      >
        <ShopMapContext.Provider
          value={{
            shopData,
            isLoading: false,
            updateShopData: mockUpdateShopData,
          }}
        >
          {component}
        </ShopMapContext.Provider>
      </SignerContext.Provider>
    </NostrContext.Provider>
  );
  return { mockUpdateShopData };
};

const STOREFRONT_AUTH_KEY = "storefront_auth_key";

describe("ShopProfileForm", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn((url: any) => {
      if (String(url).includes("/api/validate-password-auth")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ value: STOREFRONT_AUTH_KEY }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }) as jest.Mock;
  });

  afterEach(() => {
    (global.fetch as jest.Mock).mockRestore?.();
    localStorage.clear();
    mockMembership = { isPro: false, isReadOnly: false };
  });

  test("displays the form after initial data load", async () => {
    renderWithProviders(<ShopProfileForm />);
    expect(
      await screen.findByPlaceholderText("Add your shop's name...")
    ).toBeInTheDocument();
  });

  test("populates the form with existing shop data", async () => {
    renderWithProviders(<ShopProfileForm />, mockShopData);

    expect(
      await screen.findByDisplayValue("My Awesome Shop")
    ).toBeInTheDocument();

    const picture = screen.getByAltText("Stall Logo");
    const banner = screen.getByAltText("Stall Banner Image");
    expect(picture).toHaveAttribute(
      "src",
      "https://existing.image/picture.png"
    );
    expect(banner).toHaveAttribute("src", "https://existing.image/banner.png");
  });

  test("shows an empty form and default image for a new user", async () => {
    renderWithProviders(<ShopProfileForm />);
    const shopNameInput = await screen.findByPlaceholderText(
      "Add your shop's name..."
    );
    expect(shopNameInput).toHaveValue("");
  });

  test("updates form values on file upload simulation", async () => {
    renderWithProviders(<ShopProfileForm />);
    await screen.findByPlaceholderText("Add your shop's name...");
    act(() => {
      fireEvent.click(screen.getByTestId("upload-picture-btn"));
    });
    expect(await screen.findByAltText("Stall Logo")).toHaveAttribute(
      "src",
      "https://new.image/url"
    );
  });

  test("submits the form, shows loading state, and calls relevant functions", async () => {
    const user = userEvent.setup();
    let resolveCreateEvent: (value?: unknown) => void;
    mockCreateNostrShopEvent.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreateEvent = resolve;
        })
    );

    localStorage.setItem(STOREFRONT_AUTH_KEY, "true");
    const { mockUpdateShopData } = renderWithProviders(<ShopProfileForm />);

    const shopNameInput = await screen.findByPlaceholderText(
      "Add your shop's name..."
    );
    const slugInput = await screen.findByPlaceholderText("my-farm-shop");
    const saveButton = await screen.findByRole("button", {
      name: /Save Stall/i,
    });

    await user.type(shopNameInput, "New Shop Name");
    await user.type(slugInput, "new-shop");
    await user.click(saveButton);

    expect(saveButton).toBeDisabled();
    await waitFor(() => expect(createNostrShopEvent).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveCreateEvent();
    });

    expect(mockUpdateShopData).toHaveBeenCalledTimes(1);
    expect(saveButton).toBeEnabled();
  });

  test("redirects after submission if isOnboarding is true", async () => {
    mockCreateNostrShopEvent.mockResolvedValue({});
    const user = userEvent.setup();
    renderWithProviders(<ShopProfileForm isOnboarding={true} />);

    await user.type(
      await screen.findByPlaceholderText("Add your shop's name..."),
      "Onboarding Shop"
    );
    await user.click(screen.getByRole("button", { name: /Save Stall/i }));

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith("/onboarding/stripe-connect");
    });
  });

  test("shows a validation error for inputs that exceed maxLength", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ShopProfileForm />);

    const shopNameInput = await screen.findByPlaceholderText(
      "Add your shop's name..."
    );
    await user.type(
      shopNameInput,
      "This is a very long shop name that is definitely over fifty characters long for sure."
    );
    await user.click(
      await screen.findByRole("button", { name: /Save Stall/i })
    );

    expect(
      await screen.findByText("This input exceed maxLength of 50.")
    ).toBeInTheDocument();
  });

  test("submits the form when Enter is pressed on the Save button", async () => {
    mockCreateNostrShopEvent.mockResolvedValue({});
    const user = userEvent.setup();
    localStorage.setItem(STOREFRONT_AUTH_KEY, "true");
    renderWithProviders(<ShopProfileForm />);

    await user.type(
      await screen.findByPlaceholderText("Add your shop's name..."),
      "My Shop"
    );
    await user.type(
      await screen.findByPlaceholderText("my-farm-shop"),
      "my-shop"
    );
    const saveButton = await screen.findByRole("button", {
      name: /Save Stall/i,
    });

    saveButton.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(createNostrShopEvent).toHaveBeenCalledTimes(1);
    });
  });

  test("a stale DB-cached assistant opt-out is overridden when the authoritative relay event omits the field", async () => {
    // Regression: the fast path (DB cache) can carry an old
    // assistantVisibility { buyers: false } while the newer authoritative
    // relay event omits the field (absent = on-by-default). The relay load
    // must resolve the toggles unconditionally, and a subsequent save must
    // not republish the stale opt-out.
    mockMembership = { isPro: true, isReadOnly: false };
    localStorage.setItem(STOREFRONT_AUTH_KEY, "true");
    mockCreateNostrShopEvent.mockResolvedValue({});

    global.fetch = jest.fn((url: any) => {
      const u = String(url);
      if (u.includes("/api/validate-password-auth")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ value: STOREFRONT_AUTH_KEY }),
        });
      }
      if (u.includes("/api/storefront/lookup")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              shopConfig: {
                name: "Stale Cached Shop",
                storefront: {
                  shopSlug: "stale-shop",
                  assistantVisibility: { buyers: false },
                },
              },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }) as jest.Mock;

    // The newer relay event carries NO assistantVisibility — the seller never
    // opted out on this version.
    const relayShopData = new Map([
      [
        mockUserPubkey,
        {
          pubkey: mockUserPubkey,
          content: {
            name: "Fresh Relay Shop",
            about: "Authoritative relay copy.",
            ui: { picture: "https://relay.image/p.png", banner: "" },
            storefront: { shopSlug: "relay-shop" },
          },
        },
      ],
    ]);

    const user = userEvent.setup();
    const mockUpdateShopData = jest.fn();
    const tree = (shopData: Map<string, unknown>) => (
      <NostrContext.Provider value={{ nostr: {} as any }}>
        <SignerContext.Provider
          value={{ signer: {} as any, pubkey: mockUserPubkey }}
        >
          <ShopMapContext.Provider
            value={{
              shopData: shopData as any,
              isLoading: false,
              updateShopData: mockUpdateShopData,
            }}
          >
            <ShopProfileForm />
          </ShopMapContext.Provider>
        </SignerContext.Provider>
      </NostrContext.Provider>
    );

    // Relay data hasn't arrived yet (empty map) — the DB fast path wins.
    const { rerender } = render(tree(new Map()));

    const buyersToggle = await screen.findByRole("checkbox", {
      name: /Show AI Assistant to Shoppers/i,
    });
    // Stale cached opt-out visibly applied first (proves the race setup).
    await waitFor(() => expect(buyersToggle).not.toBeChecked());
    expect(screen.getByPlaceholderText("Add your shop's name...")).toHaveValue(
      "Stale Cached Shop"
    );

    // The authoritative relay event arrives later and omits the field.
    rerender(tree(relayShopData));

    await waitFor(() => expect(buyersToggle).toBeChecked());
    expect(
      screen.getByRole("checkbox", {
        name: /Show AI Assistant to Me on My Storefront/i,
      })
    ).toBeChecked();
    expect(screen.getByPlaceholderText("Add your shop's name...")).toHaveValue(
      "Fresh Relay Shop"
    );

    // Save: the stale buyers:false must not survive into the published event.
    await user.click(screen.getByRole("button", { name: /Save Stall/i }));
    await waitFor(() =>
      expect(mockCreateNostrShopEvent).toHaveBeenCalledTimes(1)
    );
    const published = JSON.parse(mockCreateNostrShopEvent.mock.calls[0][2]);
    expect(published.storefront.shopSlug).toBe("relay-shop");
    expect(published.storefront.assistantVisibility).toBeUndefined();
  });
});
