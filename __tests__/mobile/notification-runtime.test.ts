/** @jest-environment node */
import type { SellerSession } from "@self-sown/domain";
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }), {
  virtual: true,
});
jest.mock("expo-device", () => ({ isDevice: true }), { virtual: true });
jest.mock(
  "expo-constants",
  () => ({
    __esModule: true,
    default: {
      appOwnership: "standalone",
      expoConfig: {
        extra: { eas: { projectId: "60c6f74b-9ce0-4dad-a888-1d9ac30f035b" } },
      },
    },
  }),
  { virtual: true }
);
jest.mock(
  "expo-crypto",
  () => ({ randomUUID: () => "60c6f74b-9ce0-4dad-a888-1d9ac30f035b" }),
  { virtual: true }
);
jest.mock(
  "expo-secure-store",
  () => ({
    getItemAsync: jest.fn(async () => null),
    setItemAsync: jest.fn(async () => {}),
    deleteItemAsync: jest.fn(async () => {}),
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  }),
  { virtual: true }
);
jest.mock(
  "expo-notifications",
  () => ({
    getPermissionsAsync: jest.fn(async () => ({
      granted: false,
      canAskAgain: true,
    })),
    requestPermissionsAsync: jest.fn(async () => ({
      granted: true,
      canAskAgain: true,
    })),
    getExpoPushTokenAsync: jest.fn(async () => ({
      data: "ExpoPushToken[test]",
    })),
    setNotificationHandler: jest.fn(),
    dismissAllNotificationsAsync: jest.fn(async () => {}),
    clearLastNotificationResponseAsync: jest.fn(async () => {}),
  }),
  { virtual: true }
);
jest.mock("../../apps/mobile/lib/api-base-url", () => ({
  getApiBaseUrl: () => "https://local.example.invalid",
}));
jest.mock(
  "@self-sown/nostr",
  () => ({
    createNip98AuthorizationHeader: () => "Nostr test",
    deserializeSellerSession: jest.fn(),
    serializeSellerSession: jest.fn(),
  }),
  { virtual: true }
);
jest.mock(
  "@self-sown/api-client",
  () => ({
    ...jest.requireActual("@self-sown/api-client"),
    createSellerNotificationApiClient: () => ({
      requestChallenge: jest.fn(),
      confirmDevice: jest.fn(),
      revokeDevice: jest.fn(async () => {}),
      listDevices: jest.fn(),
      lookupActivity: jest.fn(),
    }),
  }),
  { virtual: true }
);
const seller: SellerSession = {
  pubkey: "a".repeat(64),
  nsec: "synthetic-test-key",
  authMethod: "nsec",
  relays: [],
  writeRelays: [],
  createdAt: 1,
};
let runtime: typeof import("../../apps/mobile/lib/notification-runtime");
let store: typeof import("../../apps/mobile/stores/session-store").useSessionStore;
let native: {
  getPermissionsAsync: jest.Mock;
  requestPermissionsAsync: jest.Mock;
};
beforeEach(() => {
  jest.resetModules();
  runtime = require("../../apps/mobile/lib/notification-runtime");
  store = require("../../apps/mobile/stores/session-store").useSessionStore;
  store.setState({ hydrated: true, session: seller });
  native = jest.requireMock("expo-notifications");
  jest
    .mocked(runtime.notificationApi.requestChallenge)
    .mockImplementation(async () => {
      runtime.receiveDeviceChallenge({
        version: 1,
        type: "device_challenge",
        challengeId: "60c6f74b-9ce0-4dad-a888-1d9ac30f035b",
        nonce: "b".repeat(64),
      });
      return {
        challengeId: "60c6f74b-9ce0-4dad-a888-1d9ac30f035b",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
    });
  jest.mocked(runtime.notificationApi.confirmDevice).mockResolvedValue({
    deviceId: "60c6f74b-9ce0-4dad-a888-1d9ac30f035b",
    enabled: true,
    generation: 1,
    revocationCapability: "c".repeat(64),
  });
});
test("background reconciliation never prompts for permission", async () => {
  await runtime.reconcileSellerAlerts();
  expect(native.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(runtime.notificationApi.requestChallenge).not.toHaveBeenCalled();
});
test("explicit opt-in prompts once and handles a challenge arriving before the HTTP response", async () => {
  native.getPermissionsAsync
    .mockResolvedValueOnce({ granted: false, canAskAgain: true })
    .mockResolvedValue({ granted: true, canAskAgain: true });
  await runtime.enableSellerAlerts();
  expect(native.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(runtime.notificationApi.confirmDevice).toHaveBeenCalledWith(
    expect.objectContaining({ nonce: "b".repeat(64) }),
    expect.anything()
  );
  expect(runtime.useNotificationState.getState().enabled).toBe(true);
});
test("permission denial never registers a token", async () => {
  native.requestPermissionsAsync.mockResolvedValue({
    granted: false,
    canAskAgain: false,
  });
  await runtime.enableSellerAlerts();
  expect(runtime.notificationApi.requestChallenge).not.toHaveBeenCalled();
  expect(runtime.useNotificationState.getState().message).toContain("denied");
});
test("signing out during the permission prompt leaves no opt-in behind", async () => {
  native.requestPermissionsAsync.mockImplementation(async () => {
    store.setState({ session: null });
    return { granted: true, canAskAgain: true };
  });
  await runtime.enableSellerAlerts();
  expect((await runtime.deviceRegistration.read()).enabledFor).toBeUndefined();
  expect(runtime.notificationApi.requestChallenge).not.toHaveBeenCalled();
});
