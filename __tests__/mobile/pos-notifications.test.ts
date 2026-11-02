/** @jest-environment node */

// Apple Tap to Pay 5.12: a declined/failed card payment must reach the seller
// as a local notification when they backgrounded the app. The helper is
// best-effort — permission denials and native errors must resolve quietly.

jest.mock("react-native", () => ({ Platform: { OS: "ios" } }), {
  virtual: true,
});

const getPermissionsAsync = jest.fn();
const requestPermissionsAsync = jest.fn();
const scheduleNotificationAsync = jest.fn(async (_content: unknown) => "id");
const setNotificationChannelAsync = jest.fn(
  async (_id: unknown, _config: unknown) => {}
);

jest.mock(
  "expo-notifications",
  () => ({
    getPermissionsAsync: () => getPermissionsAsync(),
    requestPermissionsAsync: () => requestPermissionsAsync(),
    scheduleNotificationAsync: (content: unknown) =>
      scheduleNotificationAsync(content),
    setNotificationChannelAsync: (id: unknown, config: unknown) =>
      setNotificationChannelAsync(id, config),
    AndroidImportance: { DEFAULT: 3 },
    AndroidNotificationVisibility: { PRIVATE: 0 },
  }),
  { virtual: true }
);

import {
  notifyCardPaymentApproved,
  notifyCardPaymentNotApproved,
} from "../../apps/mobile/lib/pos-notifications";

beforeEach(() => {
  jest.clearAllMocks();
  getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
  requestPermissionsAsync.mockResolvedValue({ granted: true });
});

it("schedules an immediate local notification when permission is granted", async () => {
  await notifyCardPaymentNotApproved({ amountText: "$41.00" });
  expect(scheduleNotificationAsync).toHaveBeenCalledWith({
    content: expect.objectContaining({
      title: "Card payment not approved",
      body: expect.stringContaining("$41.00"),
    }),
    trigger: null,
  });
  expect(requestPermissionsAsync).not.toHaveBeenCalled();
});

it("asks for permission when the system still allows asking", async () => {
  getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
  await notifyCardPaymentNotApproved({ amountText: "$41.00" });
  expect(requestPermissionsAsync).toHaveBeenCalled();
  expect(scheduleNotificationAsync).toHaveBeenCalled();
});

it("does not schedule when permission is denied and unaskable", async () => {
  getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
  await notifyCardPaymentNotApproved({ amountText: "$41.00" });
  expect(requestPermissionsAsync).not.toHaveBeenCalled();
  expect(scheduleNotificationAsync).not.toHaveBeenCalled();
});

it("resolves quietly when the native layer throws", async () => {
  scheduleNotificationAsync.mockRejectedValueOnce(
    new Error("no native module")
  );
  await expect(
    notifyCardPaymentNotApproved({ amountText: "$41.00" })
  ).resolves.toBeUndefined();
});

describe("notifyCardPaymentApproved", () => {
  it("schedules an immediate local notification carrying the charged amount", async () => {
    await notifyCardPaymentApproved({ amountText: "$41.00" });
    expect(scheduleNotificationAsync).toHaveBeenCalledWith({
      content: expect.objectContaining({
        title: "Card payment approved",
        body: expect.stringContaining("$41.00"),
      }),
      trigger: null,
    });
  });

  it("does not schedule when permission is denied and unaskable", async () => {
    getPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
    });
    await notifyCardPaymentApproved({ amountText: "$41.00" });
    expect(requestPermissionsAsync).not.toHaveBeenCalled();
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it("resolves quietly when the native layer throws", async () => {
    scheduleNotificationAsync.mockRejectedValueOnce(
      new Error("no native module")
    );
    await expect(
      notifyCardPaymentApproved({ amountText: "$41.00" })
    ).resolves.toBeUndefined();
  });
});
