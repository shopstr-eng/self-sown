import { render, screen } from "@testing-library/react";
import { ProfileWithDropdown } from "../profile-dropdown";
import { StorefrontBrandingProvider } from "@/utils/storefront/storefront-branding-context";

// The dropdown's sign-in modal only renders when HeroUI's useDisclosure reports
// the modal as open. Force it open so the embedded SignInModal mounts and we can
// assert the branding it receives from the dropdown's
// `sellerBranding={useStorefrontBranding() ?? undefined}` pass-through.
jest.mock("@heroui/react", () => {
  const actual = jest.requireActual("@heroui/react");
  return {
    ...actual,
    useDisclosure: () => ({
      isOpen: true,
      onOpen: jest.fn(),
      onClose: jest.fn(),
    }),
  };
});

jest.mock("next/router", () => ({
  useRouter: jest.fn(() => ({ push: jest.fn() })),
}));

// The dropdown pulls in the report-event flow (nostr publish chain). It isn't
// exercised here, so stub it to keep the heavy nostr deps out of the test.
jest.mock("@/components/utility-components/use-report-event-flow", () => ({
  __esModule: true,
  default: () => ({ openReportFlow: jest.fn(), reportFlowUi: null }),
}));

// uuid v14 / @scure/base ship ESM-only and are pulled in transitively via the
// SignInModal -> nsec signer import chain; mock them so Jest doesn't try to
// parse the untransformed ESM modules. Not exercised by these tests.
jest.mock("uuid", () => ({ v4: () => "mock-uuid-1234" }));
jest.mock("nostr-tools/nip49", () => ({
  decrypt: jest.fn(),
  encrypt: jest.fn(),
}));
// The real nostr-tools pulls in @noble/curves (ESM-only) which Jest can't parse
// here; the dropdown only needs nip19.npubEncode for the avatar/name, so a
// lightweight mock is sufficient.
jest.mock("nostr-tools", () => ({
  getPublicKey: jest.fn(),
  generateSecretKey: jest.fn(),
  finalizeEvent: jest.fn(),
  nip19: { npubEncode: (pk: string) => `npub-${pk}` },
  nip44: {},
}));
jest.mock("@/utils/nostr/nostr-helper-functions", () => ({
  LogOut: jest.fn(),
  validateNSecKey: jest.fn(),
  parseBunkerToken: jest.fn(),
  setLocalStorageDataOnSignIn: jest.fn(),
}));

function renderDropdown(withBranding: boolean) {
  const dropdown = (
    <ProfileWithDropdown pubkey="test-pubkey" dropDownKeys={["copy_npub"]} />
  );
  if (withBranding) {
    return render(
      <StorefrontBrandingProvider
        value={{
          shopName: "Happy Cow Dairy",
          logoUrl: "https://example.com/happy-cow.png",
        }}
      >
        {dropdown}
      </StorefrontBrandingProvider>
    );
  }
  return render(dropdown);
}

describe("ProfileWithDropdown sign-in modal branding", () => {
  it("shows the seller's shop name + logo when wrapped in StorefrontBrandingProvider", () => {
    renderDropdown(true);

    expect(
      screen.getByRole("heading", { name: "Happy Cow Dairy" })
    ).toBeInTheDocument();
    expect(screen.getByAltText("Happy Cow Dairy logo")).toHaveAttribute(
      "src",
      "https://example.com/happy-cow.png"
    );
  });

  it("falls back to Milk Market branding when not wrapped in a provider", () => {
    renderDropdown(false);

    expect(
      screen.getByRole("heading", { name: "Milk Market" })
    ).toBeInTheDocument();
    expect(screen.getByAltText("Milk Market logo")).toHaveAttribute(
      "src",
      "/milk-market.png"
    );
  });
});
