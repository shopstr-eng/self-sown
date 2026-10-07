/** @jest-environment node */
import { createHash } from "node:crypto";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import type { NextApiRequest, NextApiResponse } from "next";
import { createSellerNotificationsHandler } from "@/utils/notifications/http-handlers";

const key = new Uint8Array(32).fill(16),
  seller = getPublicKey(key);
const id = "123e4567-e89b-42d3-a456-426614174000";
function request(
  method: string,
  path: string,
  body?: unknown,
  proofOverride?: { path?: string; method?: string; age?: number }
) {
  const tags = [
    ["u", `https://example.com${proofOverride?.path ?? path}`],
    ["method", proofOverride?.method ?? method],
  ];
  if (body !== undefined)
    tags.push([
      "payload",
      createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    ]);
  const event = finalizeEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000) - (proofOverride?.age ?? 0),
      content: "",
      tags,
    },
    key
  );
  return {
    method,
    url: path,
    body,
    query: { deviceId: id, activityId: id },
    headers: {
      host: "example.com",
      "x-forwarded-proto": "https",
      authorization: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`,
    },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as NextApiRequest;
}
function response() {
  const res = {
    statusCode: 200,
    setHeader: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockImplementation((status: number) => {
    res.statusCode = status;
    return res;
  });
  return res as unknown as NextApiResponse;
}
function setup(enabled = true) {
  const service = {
    requestChallenge: jest.fn().mockResolvedValue({ challengeId: id }),
    confirmDevice: jest.fn(),
    listDevices: jest.fn().mockResolvedValue([]),
    revokeDevice: jest.fn(),
    lookupActivity: jest.fn().mockResolvedValue({ messageId: "a".repeat(64) }),
  };
  const getService = jest.fn().mockResolvedValue(service);
  const limit = jest.fn().mockResolvedValue({
    ok: true,
    limit: 60,
    remaining: 59,
    resetAt: Date.now() + 60000,
  });
  return {
    service,
    getService,
    limit,
    handler: (action: Parameters<typeof createSellerNotificationsHandler>[0]) =>
      createSellerNotificationsHandler(action, {
        getService,
        enabled: () => enabled,
        limit,
      }),
  };
}
describe("notification endpoint proofs", () => {
  test("derives seller ownership from a real NIP-98 signature", async () => {
    const s = setup(),
      res = response(),
      body = {
        installationId: id,
        token: "ExpoPushToken[fixture]",
        platform: "ios",
      };
    await s.handler("challenge")(
      request("POST", "/api/mobile/notifications/challenge", body),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(s.service.requestChallenge).toHaveBeenCalledWith(seller, body);
  });
  test.each([{ method: "GET" }, { path: "/different" }, { age: 600 }])(
    "rejects mismatched or expired proof %j",
    async (override) => {
      const s = setup(),
        res = response();
      await s.handler("challenge")(
        request("POST", "/api/mobile/notifications/challenge", {}, override),
        res
      );
      expect(res.statusCode).toBe(401);
      expect(s.getService).not.toHaveBeenCalled();
    }
  );
  test("rejects a tampered mutation body", async () => {
    const s = setup(),
      res = response(),
      req = request("POST", "/api/mobile/notifications/challenge", {
        installationId: id,
        token: "ExpoPushToken[fixture]",
        platform: "ios",
      });
    req.body.token = "ExpoPushToken[tampered]";
    await s.handler("challenge")(req, res);
    expect(res.statusCode).toBe(401);
  });
  test("rejects unauthenticated device reads", async () => {
    const s = setup(),
      res = response(),
      req = request("GET", "/api/mobile/notifications/devices");
    delete req.headers.authorization;
    await s.handler("devices")(req, res);
    expect(res.statusCode).toBe(401);
    expect(s.getService).not.toHaveBeenCalled();
  });
  test("does not accept a self-declared seller in the body", async () => {
    const s = setup(),
      res = response(),
      body = {
        installationId: id,
        token: "ExpoPushToken[fixture]",
        platform: "ios",
        sellerPubkey: "b".repeat(64),
      };
    await s.handler("challenge")(
      request("POST", "/api/mobile/notifications/challenge", body),
      res
    );
    expect(res.statusCode).toBe(400);
  });
  test("allows a capability only on device revocation", async () => {
    const s = setup(),
      res = response(),
      req = request("DELETE", `/api/mobile/notifications/devices/${id}`);
    delete req.headers.authorization;
    req.headers["x-mobile-device-revocation"] = "a".repeat(64);
    await s.handler("device")(req, res);
    expect(res.statusCode).toBe(200);
    expect(s.service.revokeDevice).toHaveBeenCalledWith(id, {
      capability: "a".repeat(64),
    });
  });
  test("normalizes an empty DELETE transport body without requiring a payload hash", async () => {
    const s = setup(),
      res = response(),
      req = request("DELETE", `/api/mobile/notifications/devices/${id}`);
    req.body = "";
    await s.handler("device")(req, res);
    expect(res.statusCode).toBe(200);
    expect(s.service.revokeDevice).toHaveBeenCalledWith(id, { seller });
  });
  test("preserves native request header accessors during owner revocation", async () => {
    const s = setup(),
      res = response(),
      req = request("DELETE", `/api/mobile/notifications/devices/${id}`);
    const headers = req.headers;
    delete (req as Partial<typeof req>).headers;
    Object.setPrototypeOf(req, {
      get headers() {
        return headers;
      },
    });
    req.body = "";
    await s.handler("device")(req, res);
    expect(res.statusCode).toBe(200);
    expect(s.service.revokeDevice).toHaveBeenCalledWith(id, { seller });
  });
  test("disabled feature never initializes provider registration", async () => {
    const s = setup(false),
      res = response();
    await s.handler("challenge")(
      request("POST", "/api/mobile/notifications/challenge", {}),
      res
    );
    expect(res.statusCode).toBe(503);
    expect(s.getService).not.toHaveBeenCalled();
  });
  test("rate limits before dispatch and redacts database errors", async () => {
    const s = setup(),
      res = response();
    s.limit.mockResolvedValue({
      ok: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60000,
    });
    await s.handler("devices")(
      request("GET", "/api/mobile/notifications/devices"),
      res
    );
    expect(res.statusCode).toBe(429);
    expect(s.getService).not.toHaveBeenCalled();
    const next = setup(),
      failed = response();
    next.getService.mockRejectedValue(new Error("private database secret"));
    await next.handler("devices")(
      request("GET", "/api/mobile/notifications/devices"),
      failed
    );
    expect(failed.statusCode).toBe(503);
    expect(failed.json).toHaveBeenCalledWith({
      error: "Notification service is temporarily unavailable",
    });
  });
});
