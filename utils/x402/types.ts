// x402 protocol v2 wire types for the `exact` scheme on `lnbtc`, plus the
// base64 header codecs for PAYMENT-REQUIRED / PAYMENT-SIGNATURE /
// PAYMENT-RESPONSE. Only the Lightning shapes are modeled — this project
// deliberately supports no other x402 network or token.

export interface X402ResourceInfo {
  url: string;
  description: string;
  mimeType: string;
}

export interface X402LnBtcExtra {
  assetTransferMethod: "bolt11";
  paymentFlow: "upfront";
  /** Fresh BOLT11 invoice for this exact challenge. */
  invoice: string;
  /** 64 lowercase hex chars; SHA-256 of the JCS binding object. */
  requestHash: string;
  requestBindingProfile: "http:1" | "mcp:1";
  requestBindingParams: Record<string, unknown>;
}

export interface X402PaymentRequirements {
  scheme: "exact";
  network: string;
  /** Decimal string of millisatoshis. */
  amount: string;
  asset: "BTC";
  /** Invoice signing key: 33-byte compressed secp256k1 pubkey, hex. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: X402LnBtcExtra;
}

export interface X402PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: X402ResourceInfo;
  accepts: X402PaymentRequirements[];
}

export interface X402PaymentPayload {
  x402Version: 2;
  accepted: X402PaymentRequirements;
  payload: {
    /** Exactly 64 lowercase hex chars (the 32-byte payment preimage). */
    preimage: string;
  };
}

export interface X402SettlementResponse {
  success: boolean;
  errorReason?: string;
  /** Payment hash of the settled invoice (Lightning's "transaction id"). */
  transaction?: string;
  network?: string;
}

function toBase64(json: unknown): string {
  return Buffer.from(JSON.stringify(json), "utf8").toString("base64");
}

function fromBase64(value: string): unknown {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
}

export function encodePaymentRequiredHeader(
  required: X402PaymentRequired
): string {
  return toBase64(required);
}

export function decodePaymentRequiredHeader(
  value: string
): X402PaymentRequired | null {
  try {
    const parsed = fromBase64(value) as X402PaymentRequired;
    if (
      parsed &&
      parsed.x402Version === 2 &&
      Array.isArray(parsed.accepts) &&
      parsed.accepts.length > 0
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function encodePaymentSignatureHeader(
  payload: X402PaymentPayload
): string {
  return toBase64(payload);
}

export function decodePaymentSignatureHeader(
  value: string
): X402PaymentPayload | null {
  try {
    const parsed = fromBase64(value) as X402PaymentPayload;
    if (
      parsed &&
      parsed.x402Version === 2 &&
      parsed.accepted &&
      typeof parsed.payload?.preimage === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function encodeSettlementHeader(
  settlement: X402SettlementResponse
): string {
  return toBase64(settlement);
}

export function decodeSettlementHeader(
  value: string
): X402SettlementResponse | null {
  try {
    const parsed = fromBase64(value) as X402SettlementResponse;
    if (parsed && typeof parsed.success === "boolean") return parsed;
    return null;
  } catch {
    return null;
  }
}
