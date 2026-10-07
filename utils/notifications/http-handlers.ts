import type { NextApiRequest, NextApiResponse } from "next";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { checkRateLimit, getRequestIp } from "@/utils/rate-limit";
import {
  isMobileNotificationId,
  isMobilePushToken,
  isNotificationCapability,
} from "@self-sown/domain";
import {
  NotificationServiceError,
  notificationDigest,
  type createDeviceRegistrationService,
} from "./device-registration";

type Action = "challenge" | "devices" | "device" | "activity";
export interface NotificationHandlerDependencies {
  getService: () => Promise<ReturnType<typeof createDeviceRegistrationService>>;
  enabled: () => boolean;
  limit?: typeof checkRateLimit;
}
function exactObject(
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function createSellerNotificationsHandler(
  action: Action,
  deps: NotificationHandlerDependencies
) {
  const limiter = deps.limit ?? checkRateLimit;
  return async (req: NextApiRequest, res: NextApiResponse) => {
    res.setHeader("Cache-Control", "no-store");
    const allowed =
      action === "devices"
        ? ["GET", "POST"]
        : action === "challenge"
          ? ["POST"]
          : action === "device"
            ? ["DELETE"]
            : ["GET"];
    if (!req.method || !allowed.includes(req.method)) {
      res.setHeader("Allow", allowed.join(", "));
      return res.status(405).json({ error: "Method not allowed" });
    }
    async function limit(
      scope: string,
      key: string,
      count: number
    ): Promise<boolean> {
      const rate = await limiter(scope, key, { limit: count, windowMs: 60000 });
      if (rate.ok) return true;
      res.setHeader(
        "Retry-After",
        Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))
      );
      res.status(429).json({ error: "Too many notification requests" });
      return false;
    }
    try {
      if (!(await limit("mobile-notifications:ip", getRequestIp(req), 120)))
        return;
      const capability = req.headers["x-mobile-device-revocation"];
      if (
        action === "device" &&
        !req.headers.authorization &&
        typeof capability === "string"
      ) {
        const id = req.query.deviceId;
        if (
          typeof id !== "string" ||
          !isMobileNotificationId(id) ||
          !isNotificationCapability(capability)
        )
          return res.status(404).json({ error: "Device not found" });
        const service = await deps.getService();
        await service.revokeDevice(id, { capability });
        return res.status(200).json({ success: true });
      }
      if ((req.headers.authorization?.length ?? 0) > 32768)
        return res.status(401).json({ error: "Invalid authorization" });
      if (req.method === "DELETE" && req.body !== undefined && req.body !== "")
        return res
          .status(400)
          .json({ error: "Device deletion does not accept a body" });
      // Keep the IncomingMessage instance: headers is an inherited accessor
      // in Node and is lost when the request is copied with object spread.
      if (req.method === "DELETE") req.body = undefined;
      const auth = await verifyNip98Request(req, req.method);
      if (!auth.ok)
        return res
          .status(401)
          .json({ error: "Invalid notification authorization" });
      if (
        !(await limit(
          `mobile-notifications:${action}`,
          auth.pubkey,
          action === "challenge" ? 6 : 60
        ))
      )
        return;
      if (
        (action === "challenge" ||
          (action === "devices" && req.method === "POST")) &&
        !deps.enabled()
      )
        return res
          .status(503)
          .json({ error: "Seller notifications are not enabled" });
      if (action === "challenge") {
        const body: unknown = req.body;
        if (
          !exactObject(body, ["installationId", "token", "platform"]) ||
          !isMobileNotificationId(body.installationId) ||
          !isMobilePushToken(body.token) ||
          (body.platform !== "ios" && body.platform !== "android")
        )
          return res.status(400).json({ error: "Invalid push device" });
        if (
          !(await limit(
            "mobile-notifications:token",
            notificationDigest(body.token),
            3
          ))
        )
          return;
        const service = await deps.getService();
        return res.status(200).json(
          await service.requestChallenge(auth.pubkey, {
            installationId: body.installationId,
            token: body.token,
            platform: body.platform,
          })
        );
      }
      if (action === "devices" && req.method === "POST") {
        const body: unknown = req.body;
        if (
          !exactObject(body, ["installationId", "challengeId", "nonce"]) ||
          !isMobileNotificationId(body.installationId) ||
          !isMobileNotificationId(body.challengeId) ||
          !isNotificationCapability(body.nonce)
        )
          return res.status(400).json({ error: "Invalid device confirmation" });
        const service = await deps.getService();
        return res.status(200).json(
          await service.confirmDevice(auth.pubkey, {
            installationId: body.installationId,
            challengeId: body.challengeId,
            nonce: body.nonce,
          })
        );
      }
      const service = await deps.getService();
      if (action === "devices")
        return res
          .status(200)
          .json({ devices: await service.listDevices(auth.pubkey) });
      const id =
        action === "device" ? req.query.deviceId : req.query.activityId;
      if (typeof id !== "string" || !isMobileNotificationId(id))
        return res
          .status(400)
          .json({ error: "Invalid notification identifier" });
      if (action === "activity")
        return res
          .status(200)
          .json(await service.lookupActivity(auth.pubkey, id));
      await service.revokeDevice(id, { seller: auth.pubkey });
      return res.status(200).json({ success: true });
    } catch (error) {
      if (error instanceof NotificationServiceError)
        return res.status(error.status).json({ error: error.message });
      return res
        .status(503)
        .json({ error: "Notification service is temporarily unavailable" });
    }
  };
}
