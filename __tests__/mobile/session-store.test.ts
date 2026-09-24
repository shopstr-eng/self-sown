/** @jest-environment node */

import { useSessionStore } from "@/apps/mobile/stores/session-store";

jest.mock("expo-secure-store", () => ({
  deleteItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
}));

jest.mock(
  "@milk-market/nostr",
  () => ({
    deserializeSellerSession: jest.fn(),
    serializeSellerSession: jest.fn(),
  }),
  { virtual: true }
);

const secureStore = jest.requireMock("expo-secure-store") as {
  getItemAsync: jest.Mock;
};

describe("mobile seller session hydration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSessionStore.setState({ hydrated: false, session: null });
  });

  it("fails closed without trapping the app on the loading screen", async () => {
    secureStore.getItemAsync.mockRejectedValue(
      new Error("Keychain unavailable")
    );

    await expect(useSessionStore.getState().hydrate()).rejects.toThrow(
      "Keychain unavailable"
    );
    expect(useSessionStore.getState()).toMatchObject({
      hydrated: true,
      session: null,
    });
  });
});
