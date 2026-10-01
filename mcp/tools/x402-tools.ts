// Buyer-side x402 tooling: pay any HTTP 402 challenge that speaks the x402
// `exact` scheme on Bitcoin Lightning (`lnbtc` mainnet) — this marketplace's
// own endpoints or any external service — using the buyer's server-stored
// Cashu wallet (the same kind-7375 proofs send_cashu_payment melts).
//
// Flow: fetch the resource → parse the PaymentRequired challenge (header or
// body) → validate the offered requirement (scheme/network/asset/amount/expiry
// are checked before ANY funds move) → melt wallet proofs to pay the invoice
// → retry the original request with a PAYMENT-SIGNATURE header carrying the
// preimage → return the settled response and receipt.

import { z } from "zod";
import {
  canUsePurchaseTools,
  getAgentSigner,
  type ApiKeyRecord,
} from "@/utils/mcp/auth";
import type { McpNostrSigner } from "@/utils/mcp/nostr-signing";
import { safeFetch } from "@/utils/url-safety";
import { decodeBolt11 } from "@/utils/x402/bolt11";
import {
  X402_ABSOLUTE_MAX_PAYMENT_SATS,
  X402_ASSET_BTC,
  X402_DEFAULT_MAX_PAYMENT_SATS,
  X402_HEADERS,
  X402_LNBTC_MAINNET,
  X402_SCHEME_EXACT,
} from "@/utils/x402/constants";
import {
  decodePaymentRequiredHeader,
  decodeSettlementHeader,
  encodePaymentSignatureHeader,
  type X402PaymentPayload,
  type X402PaymentRequired,
} from "@/utils/x402/types";
import { sumProofAmounts } from "@/utils/cashu/proof-amount";

const DEFAULT_WALLET_MINT = "https://mint.minibits.cash/Bitcoin";

/** Cap on the upstream response body returned to the agent. */
const MAX_UPSTREAM_BODY_CHARS = 8000;

function toolError(message: string, details: string, startTime: number) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: message,
          details,
          _meta: { responseTimeMs: Date.now() - startTime, dataSource: "live" },
        }),
      },
    ],
    isError: true as const,
  };
}

function toolSuccess(data: Record<string, unknown>, startTime: number) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ...data,
            _meta: {
              responseTimeMs: Date.now() - startTime,
              dataSource: "live",
            },
          },
          null,
          2
        ),
      },
    ],
    isError: false as const,
  };
}

/** Parse an x402 v2 challenge from a 402 response (header first, body fallback). */
async function parsePaymentRequired(
  response: Response
): Promise<X402PaymentRequired | null> {
  const header = response.headers.get(X402_HEADERS.paymentRequired);
  if (header) {
    const decoded = decodePaymentRequiredHeader(header);
    if (decoded) return decoded;
  }
  try {
    const body = await response.json();
    if (
      body &&
      body.x402Version === 2 &&
      Array.isArray(body.accepts) &&
      body.accepts.length > 0
    ) {
      return body as X402PaymentRequired;
    }
  } catch {
    // not a JSON challenge body
  }
  return null;
}

// The MCP SDK's registerTool is generic over the schema shape and its
// ToolCallback return type; a fully-loose signature accepts the registrar
// as-is without fighting the SDK's conditional types.
type RegFn = (...args: any[]) => unknown;

export function registerX402Tools(reg: RegFn, apiKey: ApiKeyRecord) {
  reg(
    "pay_x402_request",
    "Pay an x402 (HTTP 402) Bitcoin Lightning request and return the unlocked resource. Works with any URL that answers 402 with an x402 v2 `exact`-scheme Lightning (`lnbtc` mainnet) challenge — including this marketplace's own POST /api/mcp/create-order. Payment comes from your stored Cashu wallet. Refuses non-mainnet invoices, amounts above maxAmountSats, and challenges that offer no Lightning option. Returns the settlement receipt (payment hash + preimage) and the resource response.",
    {
      url: z
        .string()
        .url()
        .describe("The URL that returned (or will return) the 402 challenge"),
      method: z
        .enum(["GET", "POST"])
        .optional()
        .describe("HTTP method of the request to pay (default GET)"),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Additional request headers to send on both attempts"),
      body: z
        .string()
        .optional()
        .describe("Request body (POST only, sent verbatim on both attempts)"),
      maxAmountSats: z
        .number()
        .int()
        .min(1)
        .max(X402_ABSOLUTE_MAX_PAYMENT_SATS)
        .optional()
        .describe(
          `Spend cap in sats (default ${X402_DEFAULT_MAX_PAYMENT_SATS}, absolute max ${X402_ABSOLUTE_MAX_PAYMENT_SATS}). Invoices above the cap are rejected before payment.`
        ),
      mintUrl: z
        .string()
        .optional()
        .describe(
          `Cashu mint whose proofs pay the invoice (default ${DEFAULT_WALLET_MINT})`
        ),
    },
    async (params: {
      url: string;
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
      maxAmountSats?: number;
      mintUrl?: string;
    }) => {
      const startTime = Date.now();
      if (!canUsePurchaseTools(apiKey)) {
        return toolError(
          "Insufficient permissions",
          "This action requires a shopping API key or a seller key with purchase access.",
          startTime
        );
      }
      const signerResult = await getAgentSigner(apiKey);
      const signer = signerResult?.signer as McpNostrSigner | undefined;
      if (!signer) {
        return toolError(
          "Wallet unavailable",
          "pay_x402_request pays from your server-stored Cashu wallet, which requires a stored wallet key for this API key.",
          startTime
        );
      }

      const method = params.method ?? "GET";
      if (params.body !== undefined && method !== "POST") {
        return toolError(
          "Invalid request",
          "A request body requires method POST.",
          startTime
        );
      }
      const spendCapSats = Math.min(
        params.maxAmountSats ?? X402_DEFAULT_MAX_PAYMENT_SATS,
        X402_ABSOLUTE_MAX_PAYMENT_SATS
      );
      const walletMint = params.mintUrl || DEFAULT_WALLET_MINT;
      // SSRF guard: the Cashu SDK fetches this URL directly (it cannot route
      // through safeFetch), so the caller-supplied mint must be https on a
      // safe public hostname before any request is made to it.
      const { parseHttpUrl, isSafePublicHostname } =
        await import("@/utils/url-safety");
      const mintParsed = parseHttpUrl(walletMint);
      if (
        !mintParsed ||
        mintParsed.protocol !== "https:" ||
        !(await isSafePublicHostname(mintParsed.hostname))
      ) {
        return toolError(
          "Unsafe mint URL",
          "mintUrl must be an https:// URL on a public hostname.",
          startTime
        );
      }

      try {
        // 1. Fetch the resource; expect an x402 challenge.
        const first = await safeFetch(params.url, {
          method,
          ...(params.body !== undefined ? { body: params.body } : {}),
          headers: params.headers,
          accept: "application/json,*/*",
          timeoutMs: 20000,
        });
        if (first.status !== 402) {
          const text = (await first.text().catch(() => "")).slice(
            0,
            MAX_UPSTREAM_BODY_CHARS
          );
          return toolSuccess(
            {
              paid: false,
              reason: "no_payment_required",
              status: first.status,
              body: text,
            },
            startTime
          );
        }

        const challenge = await parsePaymentRequired(first);
        if (!challenge) {
          return toolError(
            "Unrecognized challenge",
            "The 402 response is not an x402 v2 payment challenge (no parseable PAYMENT-REQUIRED header or body).",
            startTime
          );
        }

        // 2. Pick the Lightning offer; reject anything we won't pay.
        const requirement = challenge.accepts.find(
          (a) =>
            a.scheme === X402_SCHEME_EXACT &&
            a.network === X402_LNBTC_MAINNET &&
            a.asset === X402_ASSET_BTC
        );
        if (!requirement) {
          return toolError(
            "No Lightning payment option",
            "The challenge offers no `exact` scheme option on Bitcoin Lightning mainnet (lnbtc). Other networks/tokens are not supported.",
            startTime
          );
        }
        const extra = requirement.extra as
          | Partial<import("@/utils/x402/types").X402LnBtcExtra>
          | undefined;
        if (
          extra?.assetTransferMethod !== "bolt11" ||
          extra?.paymentFlow !== "upfront" ||
          typeof extra?.invoice !== "string" ||
          !extra.invoice
        ) {
          return toolError(
            "Malformed Lightning offer",
            "The lnbtc requirement is missing a usable bolt11 invoice.",
            startTime
          );
        }
        if (!/^[0-9]+$/.test(requirement.amount)) {
          return toolError(
            "Malformed Lightning offer",
            "The requirement's amount is not a decimal millisatoshi string.",
            startTime
          );
        }
        const amountMsat = BigInt(requirement.amount);
        const amountSats = Number((amountMsat + 999n) / 1000n);
        if (amountSats > spendCapSats) {
          return toolError(
            "Amount above spend cap",
            `Invoice is ${amountSats} sats, above the ${spendCapSats} sat cap. Pass a higher maxAmountSats to proceed.`,
            startTime
          );
        }

        let invoice;
        try {
          invoice = decodeBolt11(extra.invoice);
        } catch (error) {
          return toolError(
            "Invalid invoice",
            error instanceof Error ? error.message : "Invoice failed to decode",
            startTime
          );
        }
        if (invoice.currency !== "bc") {
          return toolError(
            "Unsupported network",
            "Only Bitcoin Lightning mainnet invoices are payable. Testnet/signet/regtest invoices are refused.",
            startTime
          );
        }
        // Amountless invoices are rejected outright: with no invoice amount
        // there is nothing to bind the melt quote against, so the mint could
        // charge whatever the payee demands — a spend-cap bypass.
        if (invoice.amountMsat === null || invoice.amountMsat !== amountMsat) {
          return toolError(
            "Amount mismatch",
            invoice.amountMsat === null
              ? "The invoice carries no amount; only amount-bearing invoices are payable."
              : "The invoice amount does not match the advertised requirement amount.",
            startTime
          );
        }
        // The advertised payee must be the invoice's signing node — otherwise
        // the challenge can point settlement at a different node than the one
        // the paying agent believes it is paying.
        if (
          requirement.payTo &&
          invoice.payeeNodeKey.toLowerCase() !== requirement.payTo.toLowerCase()
        ) {
          return toolError(
            "Payee mismatch",
            "The challenge's payTo key does not match the invoice's signing node.",
            startTime
          );
        }
        const nowSec = Math.floor(Date.now() / 1000);
        if (invoice.timestamp + invoice.expirySeconds <= nowSec) {
          return toolError(
            "Invoice expired",
            "The offered invoice has already expired. Re-request the resource for a fresh challenge.",
            startTime
          );
        }

        // 3. Pay the invoice from the stored Cashu wallet.
        const {
          Mint: CashuMint,
          Wallet: CashuWallet,
          HttpResponseError,
          MintOperationError,
          JSONInt,
        } = await import("@cashu/cashu-ts");
        const { fetchCachedEvents } = await import("@/utils/db/db-service");
        const { withMintRetry } =
          await import("@/utils/cashu/mint-retry-service");
        const { safeMeltProofs } =
          await import("@/utils/cashu/melt-retry-service");

        // SSRF guard for the SDK's own HTTP: every mint call is routed
        // through safeFetch, which re-resolves and pins the destination IP
        // per hop (DNS-rebinding safe) and never follows redirects into
        // unvalidated hosts. The pre-check above alone would be bypassable —
        // the SDK's fetch resolves DNS itself.
        const guardedMintRequest = async <T>(args: {
          endpoint: string;
          requestBody?: Record<string, unknown>;
          headers?: Record<string, string>;
          method?: string;
        }): Promise<T> => {
          const response = await safeFetch(args.endpoint, {
            method: args.method ?? (args.requestBody ? "POST" : "GET"),
            headers: {
              "content-type": "application/json",
              ...(args.headers ?? {}),
            },
            // JSONInt, not JSON: Cashu Amount.toJSON() emits QUOTED strings,
            // while the wire protocol expects numeric amounts — the SDK's own
            // transport uses JSONInt for exactly this reason.
            ...(args.requestBody
              ? { body: JSONInt.stringify(args.requestBody) }
              : {}),
            accept: "application/json",
            followRedirects: false,
            timeoutMs: 20000,
          });
          const text = await response.text();
          let json: any = null;
          try {
            json = text ? JSONInt.parse(text) : null;
          } catch {
            throw new HttpResponseError(
              `Mint returned non-JSON (${response.status})`,
              response.status
            );
          }
          if (!response.ok) {
            // Mint protocol errors carry {code, detail} — the SDK's
            // isMintOperationError contract expects MintOperationError.
            if (json && typeof json.code === "number") {
              throw new MintOperationError(
                json.code,
                typeof json.detail === "string"
                  ? json.detail
                  : `Mint error ${json.code}`
              );
            }
            throw new HttpResponseError(
              (json && typeof json.detail === "string" && json.detail) ||
                `Mint request failed (${response.status})`,
              response.status
            );
          }
          return json as T;
        };
        const wallet = new CashuWallet(
          new CashuMint(walletMint, { customRequest: guardedMintRequest })
        );
        await wallet.loadMint();

        const pubkey = signer.getPubKey();
        const proofEvents = await fetchCachedEvents(7375);
        const availableProofs: any[] = [];
        const consumedEventIds: string[] = [];
        for (const event of proofEvents) {
          if ((event as any).pubkey !== pubkey) continue;
          try {
            const parsed = JSON.parse(
              signer.decrypt(pubkey, (event as any).content)
            );
            if (parsed.mint === walletMint && parsed.proofs) {
              availableProofs.push(...parsed.proofs);
              if ((event as any).id) consumedEventIds.push((event as any).id);
            }
          } catch {
            continue;
          }
        }
        if (availableProofs.length === 0) {
          return toolError(
            "No wallet balance",
            `No Cashu proofs found for mint ${walletMint}.`,
            startTime
          );
        }

        const meltQuote = await withMintRetry(
          () => wallet.createMeltQuoteBolt11(extra.invoice as string),
          {
            maxAttempts: 4,
            perAttemptTimeoutMs: 15000,
            totalTimeoutMs: 60000,
          }
        );
        const totalNeeded =
          (meltQuote.amount as any).toNumber() +
          ((meltQuote.fee_reserve as any)?.toNumber?.() || 0);
        // The cap binds the ACTUAL total the mint will consume (invoice
        // amount + fee reserve), not just the advertised amount — fees are
        // spend too.
        if (totalNeeded > spendCapSats) {
          return toolError(
            "Amount above spend cap",
            `The melt total is ${totalNeeded} sats (incl. fee reserve), above the ${spendCapSats} sat cap. Pass a higher maxAmountSats to proceed.`,
            startTime
          );
        }
        const totalAvailable = sumProofAmounts(availableProofs);
        if (totalAvailable < totalNeeded) {
          return toolError(
            "Insufficient balance",
            `Need ${totalNeeded} sats (incl. fee reserve) but the wallet holds ${totalAvailable} sats at ${walletMint}.`,
            startTime
          );
        }

        const meltOutcome = await safeMeltProofs(
          wallet,
          meltQuote,
          availableProofs
        );
        if (meltOutcome.status !== "paid") {
          return toolError(
            meltOutcome.status === "pending"
              ? "Mint payment pending"
              : meltOutcome.status === "unknown"
                ? "Cashu payment outcome unknown"
                : "Cashu payment failed",
            meltOutcome.errorMessage ??
              `Mint reported melt status: ${meltOutcome.status}`,
            startTime
          );
        }

        // Preimage: primarily from the melt response, but safeMeltProofs'
        // fallback status-check path puts it on the melt QUOTE — check both,
        // or a paid-via-fallback melt looks like a missing preimage.
        const rawPreimage =
          (meltOutcome.meltResponse?.quote as { payment_preimage?: string })
            ?.payment_preimage ??
          (meltOutcome.meltQuote as { payment_preimage?: string })
            ?.payment_preimage;
        const preimage =
          typeof rawPreimage === "string"
            ? rawPreimage.replace(/^0x/i, "").toLowerCase()
            : "";

        // Wallet accounting (the kind-7375 contract) runs on EVERY paid
        // outcome, preimage or not: the melt spent `availableProofs` and
        // returned `changeProofs`, and leaving the wallet untouched would
        // double-count spent proofs and silently drop the change. Strict
        // ordering: publish + VERIFY the replacement event is durably cached
        // before deleting the consumed events — a lost replacement with
        // deleted originals would erase the change entirely.
        let walletPersistError: string | undefined;
        try {
          const { signAndPublishEvent } =
            await import("@/utils/mcp/nostr-signing");
          const { deleteCachedEventsByIds } =
            await import("@/utils/db/db-service");
          const changeProofs = meltOutcome.changeProofs ?? [];
          const replacement = await signAndPublishEvent(signer, {
            kind: 7375,
            tags: [],
            content: signer.encrypt(
              pubkey,
              JSON.stringify({
                mint: walletMint,
                unit: "sat",
                proofs: changeProofs,
                ...(consumedEventIds.length > 0
                  ? { del: consumedEventIds }
                  : {}),
              })
            ),
            created_at: Math.floor(Date.now() / 1000),
          });
          // Durability check: cacheEvent swallows write errors internally,
          // so confirm the replacement is actually readable before removing
          // the events it supersedes.
          const cached = await fetchCachedEvents(7375);
          const confirmed = cached.some((e: any) => e.id === replacement.id);
          if (!confirmed) {
            throw new Error(
              "replacement wallet event was not durably recorded; spent proofs kept as-is"
            );
          }
          if (consumedEventIds.length > 0) {
            await deleteCachedEventsByIds(consumedEventIds);
            // Postcondition: deleteCachedEventsByIds swallows per-table
            // errors, so verify the spent events are actually gone —
            // otherwise the next spend re-submits spent proofs and fails.
            const remaining = new Set(
              (await fetchCachedEvents(7375)).map((e: any) => e.id)
            );
            const surviving = consumedEventIds.filter((id) =>
              remaining.has(id)
            );
            if (surviving.length > 0) {
              throw new Error(
                `${surviving.length} spent wallet event(s) could not be deleted; re-sync the wallet before spending again`
              );
            }
          }
        } catch (error) {
          walletPersistError =
            error instanceof Error ? error.message : "Unknown error";
        }

        if (!/^[0-9a-f]{64}$/.test(preimage)) {
          // Funds moved but the mint didn't return the preimage — fail loudly
          // with everything needed to recover rather than silently dropping it.
          return toolError(
            "Payment preimage unavailable",
            `The invoice was paid (melt quote ${(meltQuote as any).quote ?? "unknown"}) but the mint did not return a preimage. Keep the melt quote id to reconcile with the merchant. Wallet accounting: ${walletPersistError ? `FAILED — ${walletPersistError}` : "updated"}.`,
            startTime
          );
        }

        // 4. Retry the request with the payment proof. The payment has ALREADY
        // settled — an acknowledgement failure (timeout, 5xx, reset) must
        // surface as a structured paid-but-unacknowledged result carrying the
        // proof needed to retry the ack, never as a generic error that drops
        // the preimage.
        const paymentPayload: X402PaymentPayload = {
          x402Version: 2,
          accepted: requirement,
          payload: { preimage },
        };
        const paymentSignatureHeader =
          encodePaymentSignatureHeader(paymentPayload);
        let second: Response;
        try {
          second = await safeFetch(params.url, {
            method,
            ...(params.body !== undefined ? { body: params.body } : {}),
            headers: {
              ...(params.headers ?? {}),
              [X402_HEADERS.paymentSignature]: paymentSignatureHeader,
            },
            accept: "application/json,*/*",
            timeoutMs: 20000,
          });
        } catch (ackError) {
          return toolSuccess(
            {
              paid: true,
              acknowledged: false,
              ackError:
                ackError instanceof Error ? ackError.message : "Unknown error",
              x402Version: 2,
              amountSats,
              feeSats: totalNeeded - amountSats,
              paymentHash: invoice.paymentHash,
              preimage,
              paymentSignatureHeader,
              retry:
                "Payment settled. Retry the original request with the paymentSignatureHeader value as the PAYMENT-SIGNATURE header — do NOT pay again.",
              ...(walletPersistError
                ? {
                    walletPersistError: `Payment succeeded, but updating the stored wallet failed: ${walletPersistError}. Change proofs may be unrecorded — re-sync the wallet before spending again.`,
                  }
                : {}),
            },
            startTime
          );
        }
        const settlementHeader = second.headers.get(
          X402_HEADERS.paymentResponse
        );
        const settlement = settlementHeader
          ? decodeSettlementHeader(settlementHeader)
          : null;
        const bodyText = (await second.text().catch(() => "")).slice(
          0,
          MAX_UPSTREAM_BODY_CHARS
        );

        // The melt already settled — `paid` reflects that, never the
        // merchant's HTTP status. A non-2xx acknowledgement is reported as
        // unacknowledged WITH the proof attached so the agent can retry the
        // ack instead of paying again.
        return toolSuccess(
          {
            paid: true,
            acknowledged: second.ok,
            status: second.status,
            x402Version: 2,
            amountSats,
            feeSats: totalNeeded - amountSats,
            paymentHash: invoice.paymentHash,
            preimage,
            paymentSignatureHeader,
            settlement,
            body: bodyText,
            ...(!second.ok
              ? {
                  retry:
                    "Payment settled but the merchant response was not OK. Retry the original request with the paymentSignatureHeader value as the PAYMENT-SIGNATURE header — do NOT pay again.",
                }
              : {}),
            ...(walletPersistError
              ? {
                  walletPersistError: `Payment succeeded, but updating the stored wallet failed: ${walletPersistError}. Change proofs may be unrecorded — re-sync the wallet before spending again.`,
                }
              : {}),
          },
          startTime
        );
      } catch (error) {
        return toolError(
          "x402 payment failed",
          error instanceof Error ? error.message : "Unknown error",
          startTime
        );
      }
    }
  );
}
