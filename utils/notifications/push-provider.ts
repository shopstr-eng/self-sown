import type { SellerActivityPayload } from "@self-sown/domain";
export interface ProviderMessage {
  deviceId: string;
  token: string;
  title?: string;
  body?: string;
  data:
    | SellerActivityPayload
    | {
        version: 1;
        type: "device_challenge";
        challengeId: string;
        nonce: string;
      };
}
export type ProviderTicket =
  | { deviceId: string; status: "accepted"; ticketId: string }
  | { deviceId: string; status: "error"; code: string; retryable: boolean };
export type ProviderReceipt =
  | { status: "provider_accepted" }
  | { status: "error"; code: string; retryable: boolean };
export interface PushProvider {
  send(
    messages: readonly ProviderMessage[]
  ): Promise<readonly ProviderTicket[]>;
  receipts(
    ticketIds: readonly string[]
  ): Promise<Readonly<Record<string, ProviderReceipt>>>;
}
export class PushProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds = 0
  ) {
    super("Push provider request failed");
    this.name = "PushProviderError";
  }
}
