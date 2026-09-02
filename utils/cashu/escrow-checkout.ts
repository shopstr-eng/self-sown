// Client-side helpers for the buyer's opt-in Cashu escrow checkout path.
//
// Escrow is never the default: it is offered only when the deployment sets
// NEXT_PUBLIC_CASHU_ESCROW_ENABLED=true AND the seller has opted in via
// storefront.acceptsEscrow. When available, the buyer signs a kind-31995
// commitment, registers it with the server, and only then locks proofs to the
// seller (P2PK, locktime = expiry, refund = buyer).
//
// CUSTODY (docs/cashu-escrow-threat-model.md): the locked proofs stay with
// the BUYER — they are stored in the localStorage escrow record and are never
// sent to the seller. The seller receives only a reference to the escrow, so
// they cannot redeem the funds unilaterally; funds move only through the
// signed release/refund payout flow (the buyer attaches witnessed proofs).
// The buyer-side records also power the orders-page status view and the
// post-expiry refund trigger.

import {
  getDecodedToken,
  signP2PKProofs,
  type OutputConfig,
  type Proof,
} from "@cashu/cashu-ts";
import type { Event } from "nostr-tools";
import { isEscrowClientEnabled } from "@/utils/cashu/escrow-config";
import {
  ESCROW_DEFAULT_LOCK_SECONDS,
  ESCROW_MAX_LOCK_SECONDS,
} from "@/utils/cashu/escrow-commitment";

/** Minimal storefront shape needed for the escrow eligibility check. */
export type EscrowStorefrontGate = { acceptsEscrow?: boolean } | null | undefined;

/** True only when the deployment flag is on AND the seller opted in. */
export function isEscrowAvailableForSeller(
  storefront: EscrowStorefrontGate
): boolean {
  return isEscrowClientEnabled() && storefront?.acceptsEscrow === true;
}

/** Default commitment expiry (unix seconds) offered at checkout. */
export function defaultEscrowExpiresAt(
  nowSeconds: number = Math.floor(Date.now() / 1000)
): number {
  return nowSeconds + ESCROW_DEFAULT_LOCK_SECONDS;
}

/**
 * OutputConfig that locks the swapped "send" proofs to the seller with a
 * buyer refund path after the locktime. Matches the construction the payout
 * worker validates (utils/cashu/escrow-payout.ts): data = seller, locktime =
 * commitment expiry, refund = exactly the buyer, SIG_INPUTS, no multisig.
 */
export function buildEscrowLockOutputConfig(args: {
  sellerPubkey: string;
  buyerPubkey: string;
  expiresAt: number;
}): OutputConfig {
  return {
    send: {
      type: "p2pk",
      options: {
        pubkey: args.sellerPubkey,
        locktime: args.expiresAt,
        refundKeys: [args.buyerPubkey],
        sigFlag: "SIG_INPUTS",
      },
    },
  };
}

// ── Buyer-side escrow records (localStorage) ────────────────────────────────

export interface BuyerEscrowRecord {
  escrowId: string;
  orderId: string;
  sellerPubkey: string;
  amountSats: number;
  mintUrl: string;
  /** unix seconds */
  expiresAt: number;
  /** unix seconds */
  createdAt: number;
  /**
   * The P2PK-locked token the buyer RETAINS. Never sent to the seller — it is
   * the material the buyer signs and attaches when requesting a refund after
   * expiry (and later hands over to authorize a release).
   */
  lockedToken: string;
}

const BUYER_ESCROW_STORAGE_KEY = "cashu_escrows";

/** Newest first. Malformed storage is treated as empty, never fatal. */
export function listBuyerEscrows(): BuyerEscrowRecord[] {
  try {
    const raw = localStorage.getItem(BUYER_ESCROW_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (record): record is BuyerEscrowRecord =>
        !!record &&
        typeof record.escrowId === "string" &&
        typeof record.orderId === "string" &&
        typeof record.sellerPubkey === "string" &&
        typeof record.amountSats === "number" &&
        typeof record.mintUrl === "string" &&
        typeof record.expiresAt === "number" &&
        typeof record.createdAt === "number" &&
        typeof record.lockedToken === "string"
    );
  } catch {
    return [];
  }
}

/**
 * Record an escrow the buyer just locked, deduped by escrow id (a retry after
 * a post-lock failure re-registers the SAME escrow id, so this stays a
 * no-op). NEVER truncated: each record holds the only custody material (the
 * locked token) for a possibly-unresolved escrow, so evicting one can
 * irreversibly strand funds. Returns false when the write failed — callers
 * MUST treat that as fatal and surface a loud error.
 */
export function recordBuyerEscrow(record: BuyerEscrowRecord): boolean {
  try {
    const existing = listBuyerEscrows().filter(
      (entry) => entry.escrowId !== record.escrowId
    );
    localStorage.setItem(
      BUYER_ESCROW_STORAGE_KEY,
      JSON.stringify([record, ...existing])
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove records the caller KNOWS are terminal — released (the payout worker
 * spent the locked proofs) or refunded AND redeemed. Their locked tokens are
 * dead weight, so pruning them is safe. Never call with unresolved ids.
 */
export function pruneResolvedBuyerEscrows(escrowIds: string[]): void {
  if (escrowIds.length === 0) return;
  try {
    const keep = listBuyerEscrows().filter(
      (entry) => !escrowIds.includes(entry.escrowId)
    );
    localStorage.setItem(BUYER_ESCROW_STORAGE_KEY, JSON.stringify(keep));
  } catch {
    // Pruning is hygiene only — never fatal.
  }
}

// ── Payout proof decoding & witness signing ─────────────────────────────────

/**
 * Decode a retained escrow token into its mint and locked proofs. The empty
 * keysets arg is required by cashu-ts (v2 keyset-id mapping). Amounts come
 * back as Amount objects that JSON-serialize as strings; the server-side
 * payout validator requires plain safe integers, so normalize them here.
 * (The cashu-ts Proof type declares amount as Amount — the cast keeps the
 * wire format honest.)
 */
export function decodeEscrowLockedProofs(lockedToken: string): {
  mint: string;
  proofs: Proof[];
} {
  const decoded = getDecodedToken(lockedToken, []);
  const rawProofs = decoded.proofs;
  if (!Array.isArray(rawProofs) || rawProofs.length === 0) {
    throw new Error("Escrow record holds no locked proofs.");
  }
  const proofs = rawProofs.map((proof) => ({
    ...proof,
    amount:
      typeof proof.amount === "number"
        ? proof.amount
        : Number(String(proof.amount)),
  })) as unknown as Proof[];
  return { mint: decoded.mint, proofs };
}

/**
 * Sign P2PK witnesses on escrow proofs with the signer's private key
 * (SIG_INPUTS — the mint then accepts the swap). Used by the buyer (refund
 * after expiry) and by the seller (release before expiry, and redeeming a
 * seller-locked payout).
 *
 * Only key-based signers can do this (the witness is a raw Schnorr signature
 * over each proof secret, which neither NIP-07 event signing nor NIP-46
 * bunkers expose here). Fails loudly for unsupported signers.
 */
export async function signEscrowProofsWithSigner(
  proofs: Proof[],
  signer: unknown
): Promise<Proof[]> {
  const keySigner = signer as { _getPrivKey?: () => Promise<Uint8Array> };
  if (typeof keySigner._getPrivKey !== "function") {
    throw new Error(
      "Escrow payouts require signing with your private key. Log in with your key (not a remote signer) to move these funds."
    );
  }
  const privKeyBytes = await keySigner._getPrivKey();
  const privKeyHex = Array.from(privKeyBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // The library only attaches a witness when the signer is the entitled key
  // for the lock's CURRENT window (seller before expiry, buyer after), and
  // it swallows per-proof signing failures into log warnings — so verify the
  // witnesses landed and fail loudly ourselves.
  const witnessed = signP2PKProofs(proofs, privKeyHex);
  for (const proof of witnessed) {
    const witness =
      typeof proof.witness === "string"
        ? JSON.parse(proof.witness)
        : (proof.witness as { signatures?: string[] } | undefined);
    if (!witness?.signatures?.length) {
      throw new Error(
        "These escrow proofs could not be signed by your key — the entitled signer differs per lock window (seller before the lock date, buyer after)."
      );
    }
  }
  return witnessed;
}

/**
 * Sign the buyer-retained locked proofs so the payout worker can refund them
 * after expiry.
 */
export async function signEscrowLockedProofs(
  lockedToken: string,
  signer: unknown
): Promise<Proof[]> {
  return signEscrowProofsWithSigner(
    decodeEscrowLockedProofs(lockedToken).proofs,
    signer
  );
}

// ── Server calls ────────────────────────────────────────────────────────────

async function postEscrowJson(path: string, payload: unknown): Promise<any> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      body?.error || `Escrow request failed (${response.status}).`
    );
  }
  return body;
}

/**
 * Register the buyer-signed commitment BEFORE any proofs are locked. Throws
 * with the server's message on rejection so checkout can abort before funds
 * move.
 */
export async function registerEscrowCommitmentWithServer(
  commitmentEvent: Event
): Promise<{ escrowId: string; status: string; replayed: boolean }> {
  return postEscrowJson("/api/cashu/escrow/register", { commitmentEvent });
}

export interface EscrowStatusResponse {
  escrowId: string;
  status: "locked" | "released" | "refunded";
  /** unix seconds */
  expiresAt: number;
  /** Non-null while a payout action is pending/processing. */
  pendingAction: "release" | "refund" | null;
  /**
   * Whether the signed payout payload has been attached to the pending
   * action. False on a payload-less pending refund (e.g. auto-enqueued by
   * the expiry sweep) — the buyer must still complete it.
   */
  payloadAttached: boolean;
  /**
   * Once the payout has completed: the fresh proofs, P2PK-locked to the
   * payee (buyer for refunds, seller for releases). Only escrow-id holders
   * ever see this response, and the outputs are useless to anyone but the
   * payee.
   */
  payoutToken?: string;
  /** True while a buyer-approved release waits for the seller's witness. */
  releaseAwaitingSeller?: boolean;
  /**
   * The raw locked proofs, served only while a release awaits the seller's
   * witness — the seller signs them to complete the release. Unspendable by
   * anyone else (seller-locked pre-expiry, buyer-refundable after).
   */
  releaseProofs?: Proof[];
  /** The escrow's mint (needed to redeem payouts). */
  mintUrl?: string;
}

/** Null when the escrow is unknown server-side (e.g. registration failed). */
export async function fetchEscrowStatus(
  escrowId: string
): Promise<EscrowStatusResponse | null> {
  const response = await fetch(
    `/api/cashu/escrow/status?escrowId=${encodeURIComponent(escrowId)}`
  );
  if (response.status === 404) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      body?.error || `Escrow status check failed (${response.status}).`
    );
  }
  return body as EscrowStatusResponse;
}

export interface EscrowRefundResponse {
  escrowId: string;
  status: "refund_pending" | "refund_processing" | "refunded";
  enqueued: boolean;
  /** False when the worker had already claimed the entry — retry if stuck. */
  attached?: boolean;
  payoutToken?: string;
}

/**
 * Buyer-signed refund trigger, callable only after the lock expires. Sends
 * the signed action event AND the buyer-witnessed locked proofs; the server
 * validates both against the registered commitment and attaches the payload
 * to the payout outbox in one request, so a successful response means the
 * refund can actually complete.
 */
export async function requestEscrowRefund(
  actionEvent: Event,
  payoutProofs: Proof[]
): Promise<EscrowRefundResponse> {
  return postEscrowJson("/api/cashu/escrow/refund", {
    actionEvent,
    payoutProofs,
  });
}

export interface EscrowReleaseResponse {
  escrowId: string;
  status: "release_pending" | "release_processing" | "released";
  enqueued: boolean;
  /** False when the worker had already claimed the entry — retry if stuck. */
  attached?: boolean;
  payoutToken?: string;
}

/**
 * Buyer-signed EARLY release approval (pre-expiry only): hands the raw
 * locked proofs to the server at stage "awaiting_seller_witness" so the
 * seller — the only key that can witness them before expiry — can complete
 * the payout.
 */
export async function requestEscrowReleaseApproval(
  actionEvent: Event,
  proofs: Proof[]
): Promise<EscrowReleaseResponse> {
  return postEscrowJson("/api/cashu/escrow/release-approve", {
    actionEvent,
    proofs,
  });
}

/**
 * Seller-signed release completion: the seller-witnessed locked proofs are
 * validated against the registered commitment and attached to the payout
 * outbox in one request, so a successful response means the release can
 * actually complete.
 */
export async function requestEscrowRelease(
  actionEvent: Event,
  payoutProofs: Proof[]
): Promise<EscrowReleaseResponse> {
  return postEscrowJson("/api/cashu/escrow/release", {
    actionEvent,
    payoutProofs,
  });
}

export { ESCROW_DEFAULT_LOCK_SECONDS, ESCROW_MAX_LOCK_SECONDS };
