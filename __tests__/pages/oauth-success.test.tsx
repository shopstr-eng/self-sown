import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";

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
import { setLocalStorageDataOnSignIn } from "@/utils/nostr/nostr-helper-functions";

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

async function renderWithParams(params: Record<string, string>) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true, json: async () => ({
      ...BASE_PARAMS, ...params, isNewUser: params.isNewUser === "true",
    }),
  });
  window.history.replaceState({}, "", "/auth/oauth-success");
  const view = render(
    <StrictMode>
    <SignerContext.Provider value={signerValue}>
      <RelaysContext.Provider value={relaysValue}>
        <OAuthSuccess />
      </RelaysContext.Provider>
    </SignerContext.Provider>
    </StrictMode>
  );
  fireEvent.change(await screen.findByLabelText("Local unlock passphrase"), { target: { value: "real-local-unlock-phrase" } });
  fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value: "real-local-unlock-phrase" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  setRouter();
  global.fetch = jest.fn();
});

describe("oauth-success post-login routing", () => {
  it("seller flow lands on /settings for a new user", async () => {
    await renderWithParams({ isNewUser: "true", flow: "seller" });
    await waitFor(() => {
      expect(currentRouter.replace).toHaveBeenCalledWith("/settings");
    });
  });

  it("seller flow lands on /settings for an existing user", async () => {
    await renderWithParams({ isNewUser: "false", flow: "seller" });
    await waitFor(() => {
      expect(currentRouter.replace).toHaveBeenCalledWith("/settings");
    });
  });

  it("buyer sign-up (new user, no marker) lands on /marketplace", async () => {
    await renderWithParams({ isNewUser: "true" });
    await waitFor(() => {
      expect(currentRouter.replace).toHaveBeenCalledWith("/marketplace");
    });
  });

  it("buyer sign-in (existing user) lands on /marketplace", async () => {
    await renderWithParams({ isNewUser: "false" });
    await waitFor(() => {
      expect(currentRouter.replace).toHaveBeenCalledWith("/marketplace");
    });
  });

  it("custom-stall sign-up (buyerOnlySignup marker) still routes through user-type", async () => {
    localStorage.setItem("buyerOnlySignup", String(Date.now()));
    await renderWithParams({ isNewUser: "true" });
    await waitFor(() => {
      expect(currentRouter.replace).toHaveBeenCalledWith("/onboarding/user-type");
    });
  });

  it("seller flow wins over a leftover buyerOnlySignup marker", async () => {
    localStorage.setItem("buyerOnlySignup", String(Date.now()));
    await renderWithParams({ isNewUser: "true", flow: "seller" });
    await waitFor(() => {
      expect(currentRouter.replace).toHaveBeenCalledWith("/settings");
    });
  });
});

it("consumes the cookie once under StrictMode, without URL credentials or a predictable unlock", async () => {
  await renderWithParams({ isNewUser: "false" });
  await waitFor(() => expect(currentRouter.replace).toHaveBeenCalled());
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledWith("/api/auth/oauth-handoff", expect.objectContaining({
    method: "POST", credentials: "same-origin", headers: { "X-OAuth-Handoff": "1" },
  }));
  expect(signerValue.newSigner).toHaveBeenCalledWith("nsec", expect.objectContaining({
    passphrase: "real-local-unlock-phrase", memoryOnlyUnlock: true,
  }));
  expect(JSON.stringify(localStorage)).not.toContain("real-local-unlock-phrase");
  expect(window.location.search).toBe("");
});

it("keeps the old saved account and does not navigate if re-encryption cannot be persisted", async () => {
  localStorage.setItem("signer", "old-encrypted-key");
  (setLocalStorageDataOnSignIn as jest.Mock).mockRejectedValueOnce(new Error("Storage unavailable"));
  await renderWithParams({ isNewUser: "false" });
  expect(await screen.findByRole("alert")).toHaveTextContent("Storage unavailable");
  expect(localStorage.getItem("signer")).toBe("old-encrypted-key");
  expect(currentRouter.replace).not.toHaveBeenCalled();
});
