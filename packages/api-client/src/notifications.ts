import {
  isMobileNotificationId,
  isMobilePushToken,
  isNotificationCapability,
  type NotificationDeviceChallengeInput,
  type NotificationDeviceConfirmationInput,
  type NotificationRegistration,
  type NotificationDeviceSummary,
  type SellerActivityLookup,
} from "@self-sown/domain";

export interface NotificationAuthorizationRequest {
  path: string;
  method: "GET" | "POST" | "DELETE";
  body?: string;
}
export interface NotificationAuthorization {
  authorize: (request: NotificationAuthorizationRequest) => string;
}
export class SellerNotificationApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code:
      | "INVALID_REQUEST"
      | "INVALID_RESPONSE"
      | "REQUEST_FAILED"
  ) {
    super(message);
    this.name = "SellerNotificationApiError";
  }
}
function invalidInput(): never {
  throw new SellerNotificationApiError(
    "Invalid notification request.",
    0,
    "INVALID_REQUEST"
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function checkId(value: string): string {
  if (!isMobileNotificationId(value)) invalidInput();
  return value;
}
const ROOT = "/api/mobile/notifications";

export function createSellerNotificationApiClient(
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}
) {
  const baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
  const transport = options.fetchImpl ?? fetch;
  async function request(
    path: string,
    method: NotificationAuthorizationRequest["method"],
    auth: NotificationAuthorization | { revocationCapability: string },
    input?: unknown
  ): Promise<Record<string, unknown>> {
    const body = input === undefined ? undefined : JSON.stringify(input);
    const headers = new Headers({
      Accept: "application/json",
    });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if ("revocationCapability" in auth) {
      if (
        method !== "DELETE" ||
        !isNotificationCapability(auth.revocationCapability)
      )
        invalidInput();
      headers.set("X-Mobile-Device-Revocation", auth.revocationCapability);
    } else {
      const proof = auth.authorize({
        path,
        method,
        ...(body === undefined ? {} : { body }),
      });
      if (
        typeof proof !== "string" ||
        !proof.startsWith("Nostr ") ||
        proof.length > 32768 ||
        /[\u0000-\u001f\u007f]/.test(proof)
      )
        invalidInput();
      headers.set("Authorization", proof);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      let response: Response;
      try {
        response = await transport(baseUrl + path, {
          method,
          headers,
          signal: controller.signal,
          ...(body === undefined ? {} : { body }),
        });
      } catch {
        throw new SellerNotificationApiError(
          "Unable to reach the notification service.",
          0,
          "REQUEST_FAILED"
        );
      }
      // Never surface arbitrary provider/server errors that can contain tokens.
      if (!response.ok)
        throw new SellerNotificationApiError(
          "Unable to complete the notification request.",
          response.status,
          "REQUEST_FAILED"
        );
      try {
        const value: unknown = JSON.parse(await response.text());
        if (record(value)) return value;
      } catch {
        /* Redact malformed transport content. */
      }
      throw new SellerNotificationApiError(
        "Invalid notification service response.",
        response.status,
        "INVALID_RESPONSE"
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  function invalidResponse(): never {
    throw new SellerNotificationApiError(
      "Invalid notification service response.",
      200,
      "INVALID_RESPONSE"
    );
  }
  return {
    async requestChallenge(
      input: NotificationDeviceChallengeInput,
      auth: NotificationAuthorization
    ) {
      if (
        !isMobileNotificationId(input.installationId) ||
        !isMobilePushToken(input.token) ||
        !["ios", "android"].includes(input.platform)
      )
        invalidInput();
      const data = await request(`${ROOT}/challenge`, "POST", auth, {
        installationId: input.installationId,
        token: input.token,
        platform: input.platform,
      });
      if (!isMobileNotificationId(data.challengeId)) invalidResponse();
      return { challengeId: data.challengeId };
    },
    async confirmDevice(
      input: NotificationDeviceConfirmationInput,
      auth: NotificationAuthorization
    ): Promise<NotificationRegistration> {
      if (
        !isMobileNotificationId(input.installationId) ||
        !isMobileNotificationId(input.challengeId) ||
        !isNotificationCapability(input.nonce)
      )
        invalidInput();
      const data = await request(`${ROOT}/devices`, "POST", auth, {
        installationId: input.installationId,
        challengeId: input.challengeId,
        nonce: input.nonce,
      });
      if (
        !isMobileNotificationId(data.deviceId) ||
        typeof data.enabled !== "boolean" ||
        typeof data.generation !== "number" ||
        !Number.isSafeInteger(data.generation) ||
        data.generation < 1 ||
        !isNotificationCapability(data.revocationCapability)
      )
        invalidResponse();
      return {
        deviceId: data.deviceId,
        enabled: data.enabled,
        generation: data.generation,
        revocationCapability: data.revocationCapability,
      };
    },
    async listDevices(
      auth: NotificationAuthorization
    ): Promise<NotificationDeviceSummary[]> {
      const data = await request(`${ROOT}/devices`, "GET", auth);
      if (!Array.isArray(data.devices) || data.devices.length > 100)
        invalidResponse();
      return data.devices.map((device: unknown) => {
        if (
          !record(device) ||
          !isMobileNotificationId(device.deviceId) ||
          (device.platform !== "ios" && device.platform !== "android") ||
          typeof device.enabled !== "boolean" ||
          typeof device.lastSeenAt !== "string" ||
          !Number.isFinite(Date.parse(device.lastSeenAt))
        )
          invalidResponse();
        return {
          deviceId: device.deviceId,
          platform: device.platform,
          enabled: device.enabled,
          lastSeenAt: device.lastSeenAt,
        };
      });
    },
    async revokeDevice(
      deviceId: string,
      auth: NotificationAuthorization | { revocationCapability: string }
    ): Promise<void> {
      const data = await request(
        `${ROOT}/devices/${checkId(deviceId)}`,
        "DELETE",
        auth
      );
      if (data.success !== true) invalidResponse();
    },
    async lookupActivity(
      activityId: string,
      auth: NotificationAuthorization
    ): Promise<SellerActivityLookup> {
      const data = await request(
        `${ROOT}/activity/${checkId(activityId)}`,
        "GET",
        auth
      );
      if (
        typeof data.messageId !== "string" ||
        !/^[0-9a-f]{64}$/.test(data.messageId)
      )
        invalidResponse();
      return { messageId: data.messageId };
    },
  };
}
