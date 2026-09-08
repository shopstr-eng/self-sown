/** @jest-environment node */
import { createExpoPushProvider } from "../expo-provider";
const activityId = "123e4567-e89b-42d3-a456-426614174000";
const message = {
  deviceId: "device",
  token: "ExpoPushToken[fixture]",
  title: "Milk Market",
  body: "New seller activity. Open the app to review.",
  data: { version: 1 as const, type: "seller_activity" as const, activityId },
};
const response = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {}
) => ({
  ok: status < 400,
  status,
  headers: new Headers(headers),
  json: async () => data,
});
describe("Expo provider transport", () => {
  test("uses a fixed endpoint and protected server credential, preserving ticket correlation", async () => {
    const transport = jest
      .fn()
      .mockResolvedValue(
        response({ data: [{ status: "ok", id: "ticket-1" }] })
      );
    const provider = createExpoPushProvider({
      accessToken: "server-key",
      fetchImpl: transport as typeof fetch,
    });
    await expect(provider.send([message])).resolves.toEqual([
      { deviceId: "device", status: "accepted", ticketId: "ticket-1" },
    ]);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    expect(init.headers.Authorization).toBe("Bearer server-key");
    const body = JSON.parse(init.body);
    expect(body[0].to).toBe(message.token);
    expect(body[0]).not.toHaveProperty("deviceId");
    expect(body[0].data).toEqual(message.data);
  });
  test("normalizes invalid-device errors without retaining raw provider text", async () => {
    const transport = jest.fn().mockResolvedValue(
      response({
        data: [
          {
            status: "error",
            message: "private token",
            details: { error: "DeviceNotRegistered" },
          },
        ],
      })
    );
    const provider = createExpoPushProvider({
      accessToken: "key",
      fetchImpl: transport as typeof fetch,
    });
    await expect(provider.send([message])).resolves.toEqual([
      {
        deviceId: "device",
        status: "error",
        code: "DeviceNotRegistered",
        retryable: false,
      },
    ]);
  });
  test.each([429, 500, 503])(
    "retries transient HTTP status %s with Retry-After",
    async (status) => {
      const provider = createExpoPushProvider({
        accessToken: "key",
        fetchImpl: jest
          .fn()
          .mockResolvedValue(response({}, status, { "Retry-After": "120" })),
      });
      await expect(provider.send([message])).rejects.toMatchObject({
        code: "ProviderUnavailable",
        retryable: true,
        retryAfterSeconds: 120,
      });
    }
  );
  test("receipt success represents a provider handoff", async () => {
    const provider = createExpoPushProvider({
      accessToken: "key",
      fetchImpl: jest.fn().mockResolvedValue(
        response({
          data: {
            ticket: { status: "ok" },
            invalid: {
              status: "error",
              details: { error: "DeviceNotRegistered" },
            },
          },
        })
      ),
    });
    await expect(
      provider.receipts(["ticket", "invalid", "missing"])
    ).resolves.toEqual({
      ticket: { status: "provider_accepted" },
      invalid: {
        status: "error",
        code: "DeviceNotRegistered",
        retryable: false,
      },
    });
  });
  test("rejects mismatched ticket counts as uncertain delivery", async () => {
    const provider = createExpoPushProvider({
      accessToken: "key",
      fetchImpl: jest.fn().mockResolvedValue(response({ data: [] })),
    });
    await expect(provider.send([message])).rejects.toMatchObject({
      code: "InvalidProviderResponse",
      retryable: true,
    });
  });
  test("does not initialize without push security credentials", () => {
    expect(() => createExpoPushProvider({ accessToken: "" })).toThrow(
      "Push provider credentials are not configured"
    );
  });
});
