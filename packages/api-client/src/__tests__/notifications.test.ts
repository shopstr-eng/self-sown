import {
  createSellerNotificationApiClient,
  SellerNotificationApiError,
} from "../notifications";

const id = "123e4567-e89b-42d3-a456-426614174000";
const capability = "a".repeat(64);
const nonce = "b".repeat(64);
const requestInput = {
  installationId: id,
  token: "ExpoPushToken[test-token]",
  platform: "ios" as const,
};
const response = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => JSON.stringify(body),
});

function setup(body: unknown, status = 200) {
  const transport = jest.fn().mockResolvedValue(response(body, status));
  const authorize = jest.fn().mockReturnValue("Nostr fixture");
  const client = createSellerNotificationApiClient({
    baseUrl: "https://example.com/",
    fetchImpl: transport as typeof fetch,
  });
  return { client, transport, authorize };
}

describe("seller notification client", () => {
  test("signs the exact challenge request and sends only supported fields", async () => {
    const { client, transport, authorize } = setup({ challengeId: id });
    await expect(
      client.requestChallenge(requestInput, { authorize })
    ).resolves.toEqual({ challengeId: id });
    const body = JSON.stringify(requestInput);
    expect(authorize).toHaveBeenCalledWith({
      path: "/api/mobile/notifications/challenge",
      method: "POST",
      body,
    });
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://example.com/api/mobile/notifications/challenge");
    expect(init.body).toBe(body);
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Nostr fixture"
    );
  });
  test("confirms a device using its matching challenge nonce", async () => {
    const registration = {
      deviceId: id,
      enabled: true,
      generation: 1,
      revocationCapability: capability,
    };
    const { client, authorize } = setup(registration);
    await expect(
      client.confirmDevice(
        { installationId: id, challengeId: id, nonce },
        { authorize }
      )
    ).resolves.toEqual(registration);
  });
  test("authenticates the exact activity resource path", async () => {
    const { client, authorize } = setup({ messageId: "a".repeat(64) });
    await client.lookupActivity(id, { authorize });
    expect(authorize).toHaveBeenCalledWith({
      path: `/api/mobile/notifications/activity/${id}`,
      method: "GET",
    });
  });
  test("signs owner revocation with DELETE", async () => {
    const { client, authorize, transport } = setup({ success: true });
    await client.revokeDevice(id, { authorize });
    expect(authorize).toHaveBeenCalledWith({
      path: `/api/mobile/notifications/devices/${id}`,
      method: "DELETE",
    });
    // Next parses an empty application/json request as {}, which would no
    // longer match this signed bodyless DELETE contract.
    const init = transport.mock.calls[0][1];
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
  });
  test("supports capability-only cleanup without retaining a seller session", async () => {
    const { client, transport } = setup({ success: true });
    await client.revokeDevice(id, { revocationCapability: capability });
    const headers = new Headers(transport.mock.calls[0][1].headers);
    expect(headers.get("X-Mobile-Device-Revocation")).toBe(capability);
    expect(headers.has("Authorization")).toBe(false);
  });
  test.each(["../other", "", "x".repeat(2048)])(
    "rejects malformed resource identifiers before signing %s",
    async (invalid) => {
      const { client, transport, authorize } = setup({});
      await expect(
        client.lookupActivity(invalid, { authorize })
      ).rejects.toBeInstanceOf(SellerNotificationApiError);
      expect(transport).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
    }
  );
  test("rejects invalid tokens before transport", async () => {
    const { client, transport, authorize } = setup({});
    await expect(
      client.requestChallenge(
        { ...requestInput, token: "https://attacker.test" },
        { authorize }
      )
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  test("does not display provider errors containing tokens or other private data", async () => {
    const { client, authorize } = setup(
      { error: "ExpoPushToken[private] secret" },
      503
    );
    await expect(
      client.lookupActivity(id, { authorize })
    ).rejects.toMatchObject({
      status: 503,
      message: "Unable to complete the notification request.",
    });
  });
  test("rejects a malformed successful registration response", async () => {
    const { client, authorize } = setup({
      deviceId: id,
      enabled: true,
      generation: -1,
    });
    await expect(
      client.confirmDevice(
        { installationId: id, challengeId: id, nonce },
        { authorize }
      )
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  test("strips unrecognized metadata from device listings", async () => {
    const { client, authorize } = setup({
      devices: [
        {
          deviceId: id,
          platform: "ios",
          enabled: true,
          lastSeenAt: "2026-09-08T00:00:00.000Z",
          token: "private",
        },
      ],
    });
    const devices = await client.listDevices({ authorize });
    expect(devices[0]).not.toHaveProperty("token");
  });
  test("times out a stalled transport so registration can be retried", async () => {
    jest.useFakeTimers();
    try {
      const transport = jest.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted"))
            );
          })
      );
      const client = createSellerNotificationApiClient({
        fetchImpl: transport as typeof fetch,
      });
      const pending = client.listDevices({ authorize: () => "Nostr fixture" });
      expect(transport.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      const rejected = expect(pending).rejects.toMatchObject({
        code: "REQUEST_FAILED",
      });
      await jest.advanceTimersByTimeAsync(15000);
      await rejected;
    } finally {
      jest.useRealTimers();
    }
  });
  test("rejects invalid authorization without contacting the service", async () => {
    const { client, transport } = setup({});
    await expect(
      client.listDevices({ authorize: () => "Bearer invalid" })
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
