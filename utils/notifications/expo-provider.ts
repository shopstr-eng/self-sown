import type {
  PushProvider,
  ProviderTicket,
  ProviderReceipt,
} from "./push-provider";
import { PushProviderError } from "./push-provider";
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function normalizeError(value: unknown): { code: string; retryable: boolean } {
  const code =
    record(value) && typeof value.error === "string"
      ? value.error
      : "ProviderRejected";
  const allowed = [
    "DeviceNotRegistered",
    "MessageTooBig",
    "MessageRateExceeded",
    "MismatchSenderId",
    "InvalidCredentials",
  ];
  return {
    code: allowed.includes(code) ? code : "ProviderRejected",
    retryable: code === "MessageRateExceeded",
  };
}
export function createExpoPushProvider(options: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): PushProvider {
  if (
    !options.accessToken ||
    options.accessToken.length > 4096 ||
    /[\r\n]/.test(options.accessToken)
  )
    throw new Error("Push provider credentials are not configured");
  const transport = options.fetchImpl ?? fetch;
  async function post(
    path: "send" | "getReceipts",
    body: unknown
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await transport(`https://exp.host/--/api/v2/push/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
    } catch {
      throw new PushProviderError("ProviderUnavailable", true);
    }
    if (!response.ok) {
      const header = response.headers.get("Retry-After");
      const parsed = header ? Number(header) : 0;
      const retryAfterSeconds =
        Number.isFinite(parsed) && parsed >= 0
          ? Math.min(parsed, 86400)
          : Math.min(
              86400,
              Math.max(
                0,
                Math.ceil((Date.parse(header ?? "") - Date.now()) / 1000)
              ) || 0
            );
      throw new PushProviderError(
        response.status === 429 || response.status >= 500
          ? "ProviderUnavailable"
          : "ProviderRejected",
        response.status === 429 || response.status >= 500,
        retryAfterSeconds
      );
    }
    try {
      return await response.json();
    } catch {
      throw new PushProviderError("InvalidProviderResponse", true);
    }
  }
  return {
    async send(messages): Promise<ProviderTicket[]> {
      if (messages.length === 0) return [];
      if (messages.length > 100)
        throw new PushProviderError("BatchTooLarge", false);
      const response = await post(
        "send",
        messages.map((message) => ({
          to: message.token,
          data: message.data,
          ...(message.title ? { title: message.title } : {}),
          ...(message.body ? { body: message.body } : {}),
          ...(message.data.type === "seller_activity"
            ? { priority: "high", ttl: 86400, channelId: "seller-activity" }
            : { priority: "normal", ttl: 300, _contentAvailable: true }),
        }))
      );
      if (
        !record(response) ||
        !Array.isArray(response.data) ||
        response.data.length !== messages.length
      )
        throw new PushProviderError("InvalidProviderResponse", true);
      return response.data.map((ticket: unknown, index: number) => {
        const deviceId = messages[index]!.deviceId;
        if (
          record(ticket) &&
          ticket.status === "ok" &&
          typeof ticket.id === "string" &&
          ticket.id.length > 0 &&
          ticket.id.length <= 256
        )
          return { deviceId, status: "accepted", ticketId: ticket.id };
        if (record(ticket) && ticket.status === "error")
          return {
            deviceId,
            status: "error",
            ...normalizeError(ticket.details),
          };
        throw new PushProviderError("InvalidProviderResponse", true);
      });
    },
    async receipts(ticketIds): Promise<Record<string, ProviderReceipt>> {
      if (ticketIds.length === 0) return {};
      if (ticketIds.length > 1000)
        throw new PushProviderError("BatchTooLarge", false);
      const response = await post("getReceipts", { ids: ticketIds });
      if (!record(response) || !record(response.data))
        throw new PushProviderError("InvalidProviderResponse", true);
      const result: Record<string, ProviderReceipt> = {};
      for (const id of ticketIds) {
        const receipt = response.data[id];
        if (record(receipt) && receipt.status === "ok")
          result[id] = { status: "provider_accepted" };
        else if (record(receipt) && receipt.status === "error")
          result[id] = { status: "error", ...normalizeError(receipt.details) };
      }
      return result;
    },
  };
}
