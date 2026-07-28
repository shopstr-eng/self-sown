import "@testing-library/jest-dom";
import { render } from "@testing-library/react";
import SellerView from "@/pages/marketplace/[[...npub]]";

jest.mock(
  "@/components/home/home-feed",
  () =>
    function MockHomeFeed({ focusedPubkey }: { focusedPubkey: string }) {
      return <div data-testid="mock-home-feed" data-focused={focusedPubkey} />;
    }
);

// getServerSideProps dependencies — not exercised here, but the page imports
// them at module scope.
jest.mock("@/utils/db/db-service", () => ({
  fetchShopProfileByPubkeyFromDb: jest.fn(),
  fetchProfilePubkeyByNameSlug: jest.fn(),
  fetchProductsByPubkeyFromDb: jest.fn(),
  getShopSlugByPubkey: jest.fn(),
}));
jest.mock("@/utils/parsers/product-parser-functions", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const renderSellerView = (props: Partial<Parameters<typeof SellerView>[0]>) => {
  const setFocusedPubkey = jest.fn();
  const setSelectedSection = jest.fn();
  render(
    <SellerView
      ogMeta={{ title: "", description: "", image: "", url: "" }}
      focusedPubkey=""
      setFocusedPubkey={setFocusedPubkey}
      selectedSection=""
      setSelectedSection={setSelectedSection}
      ssrSellerName=""
      ssrSellerAbout=""
      ssrProducts={[]}
      initialFocusedPubkey=""
      {...props}
    />
  );
  return { setFocusedPubkey, setSelectedSection };
};

describe("SellerView SSR pubkey seeding", () => {
  it("seeds focusedPubkey from the SSR-resolved pubkey so the grid filters to the vendor", () => {
    const { setFocusedPubkey, setSelectedSection } = renderSellerView({
      initialFocusedPubkey: "vendor-pubkey",
    });
    expect(setFocusedPubkey).toHaveBeenCalledWith("vendor-pubkey");
    expect(setSelectedSection).toHaveBeenCalledWith("shop");
  });

  it("does not re-seed when the client focus already matches", () => {
    const { setFocusedPubkey } = renderSellerView({
      initialFocusedPubkey: "vendor-pubkey",
      focusedPubkey: "vendor-pubkey",
    });
    expect(setFocusedPubkey).not.toHaveBeenCalled();
  });

  it("does not seed on the general marketplace route", () => {
    const { setFocusedPubkey } = renderSellerView({
      initialFocusedPubkey: "",
    });
    expect(setFocusedPubkey).not.toHaveBeenCalled();
  });
});
