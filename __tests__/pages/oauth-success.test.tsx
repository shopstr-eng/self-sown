import { render, waitFor } from "@testing-library/react";

import { RelaysContext } from "@/utils/context/context";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";

// Router mock — each test installs a fresh push spy via setRouter().
let currentRouter: any;
const setRouter = () => {
  currentRouter = { push: jest.fn(), replace: jest.fn() };
  return currentRouter;
};
jest.mock("next/router", () => ({
  useRouter: () => currentRouter,
}));

// The real signer/helper chains pull in ESM-only deps Jest can't parse; the
// routing logic under test never exercises real crypto.
jest.mock("@/utils/nostr/nostr-helper-functions", () => ({
  setLocalStorageDataOnSignIn: jest.fn(),
}));
jest.mock("@/utils/nostr/signers/nostr-nsec-signer", () => ({
  NostrNSecSigner: {
    getEncryptedNSEC: jest.fn(() => ({
      encryptedPrivKey: "enc",
      pubkey: "pk_test",
    })),
  },
}));

import OAuthSuccess from "@/pages/auth/oauth-success";

const relaysValue = {
  relayList: [],
  readRelayList: [],
  writeRelayList: [],
  isLoading: false,
} as any;

const signerValue = {
  newSigner: jest.fn(() => ({
    getPubKey: jest.fn(async () => "pk_test"),
  })),
} as any;

const BASE_PARAMS = {
  nsec: "nsec1test",
  pubkey: "pk_test",
  provider: "google",
  email: "user@example.com",
};

function renderWithParams(params: Record<string, string>) {
  const search = new URLSearchParams({ ...BASE_PARAMS, ...params });
  // oauth-success reads window.location.search directly.
  window.history.replaceState({}, "", `/auth/oauth-success?${search}`);
  return render(
    <SignerContext.Provider value={signerValue}>
      <RelaysContext.Provider value={relaysValue}>
        <OAuthSuccess />
      </RelaysContext.Provider>
    </SignerContext.Provider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  setRouter();
});

describe("oauth-success post-login routing", () => {
  it("seller flow lands on /settings for a new user", async () => {
    renderWithParams({ isNewUser: "true", flow: "seller" });
    await waitFor(() => {
      expect(currentRouter.push).toHaveBeenCalledWith("/settings");
    });
  });

  it("seller flow lands on /settings for an existing user", async () => {
    renderWithParams({ isNewUser: "false", flow: "seller" });
    await waitFor(() => {
      expect(currentRouter.push).toHaveBeenCalledWith("/settings");
    });
  });

  it("buyer sign-up (new user, no marker) lands on /marketplace", async () => {
    renderWithParams({ isNewUser: "true" });
    await waitFor(() => {
      expect(currentRouter.push).toHaveBeenCalledWith("/marketplace");
    });
  });

  it("buyer sign-in (existing user) lands on /marketplace", async () => {
    renderWithParams({ isNewUser: "false" });
    await waitFor(() => {
      expect(currentRouter.push).toHaveBeenCalledWith("/marketplace");
    });
  });

  it("custom-stall sign-up (buyerOnlySignup marker) still routes through user-type", async () => {
    localStorage.setItem("buyerOnlySignup", String(Date.now()));
    renderWithParams({ isNewUser: "true" });
    await waitFor(() => {
      expect(currentRouter.push).toHaveBeenCalledWith("/onboarding/user-type");
    });
  });

  it("seller flow wins over a leftover buyerOnlySignup marker", async () => {
    localStorage.setItem("buyerOnlySignup", String(Date.now()));
    renderWithParams({ isNewUser: "true", flow: "seller" });
    await waitFor(() => {
      expect(currentRouter.push).toHaveBeenCalledWith("/settings");
    });
  });
});
