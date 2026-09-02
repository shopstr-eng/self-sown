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
  type Token,
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

/**
 * Lock period for new escrow commitments, in seconds. Staging/testing knob:
 * NEXT_PUBLIC_CASHU_ESCROW_LOCK_SECONDS shortens the lock so operators can
 * prove the escrow round-trip (or run kill-tests) without waiting the 14-day
 * default. Unset/invalid => default; clamped to the protocol max. Server-side
 * commitment bounds (future, <= 30 days) apply regardless.
 */
export function resolveEscrowLockSeconds(rawOverride: string | undefined): number {
  const override = Number(rawOverride);
  return Number.isFinite(override) && override > 0
    ? Math.min(Math.floor(override), ESCROW_MAX_LOCK_SECONDS)
    : ESCROW_DEFAULT_LOCK_SECONDS;
}

/** Human label for the configured lock period ("14 days", "7 minutes"). */
export function formatEscrowLockDuration(
  lockSeconds: number = resolveEscrowLockSeconds(
    process.env.NEXT_PUBLIC_CASHU_ESCROW_LOCK_SECONDS
  )
): string {
  if (lockSeconds % 86400 === 0) return `${lockSeconds / 86400} days`;
  if (lockSeconds % 3600 === 0) return `${lockSeconds / 3600} hours`;
  if (lockSeconds % 60 === 0) return `${lockSeconds / 60} minutes`;
  return `${lockSeconds} seconds`;
}

/** Default commitment expiry (unix seconds) offered at checkout. */
export function defaultEscrowExpiresAt(
  nowSeconds: number = Math.floor(Date.now() / 1000)
): number {
  return (
    nowSeconds +
    resolveEscrowLockSeconds(process.env.NEXT_PUBLIC_CASHU_ESCROW_LOCK_SECONDS)
  );
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

// ── Seller-side payout redemption markers (localStorage) ────────────────────
//
// The seller keeps no custody material locally, so unlike the buyer records
// above these markers are pure UX: once a payout token has been redeemed into
// the wallet the mint will reject it as already-spent forever after, so there
// is no reason to ever offer the redeem button again. The status endpoint
// keeps serving the (spent) payout token, so without this marker the button
// reappears after every reload and the re-click fails at the mint.

const SELLER_REDEEMED_ESCROW_STORAGE_KEY = "cashu_escrow_seller_redeemed";

/** Malformed storage is treated as empty, never fatal. */
export function listRedeemedSellerEscrows(): string[] {
  try {
    const raw = localStorage.getItem(SELLER_REDEEMED_ESCROW_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export function isSellerEscrowRedeemed(escrowId: string): boolean {
  return listRedeemedSellerEscrows().includes(escrowId);
}

/**
 * Record that a payout was redeemed into the local wallet, deduped by escrow
 * id. Best-effort: a failed write only means the button can reappear after a
 * reload (the mint still rejects the spent token), so this never throws.
 */
export function markSellerEscrowRedeemed(escrowId: string): void {
  try {
    const existing = listRedeemedSellerEscrows().filter(
      (id) => id !== escrowId
    );
    localStorage.setItem(
      SELLER_REDEEMED_ESCROW_STORAGE_KEY,
      JSON.stringify([escrowId, ...existing])
    );
  } catch {
    // Marker is hygiene only — never fatal.
  }
}

/**
 * True when the mint rejected a swap because the input proofs are ALREADY
 * spent — which, for an escrow payout token, means the payout was already
 * redeemed (e.g. on another device/browser, where the localStorage marker
 * above doesn't exist). Callers should treat this as success, not failure:
 * the money is already in the seller's wallet. Detection uses both the
 * NUT-00 error code (11001 "token already spent", surfaced by cashu-ts as
 * MintOperationError.code) and a message fallback for mints that don't
 * implement structured error codes.
 */
export function isMintAlreadySpentError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 11001) return true;
  return /already\s+spent/i.test(error.message);
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
/**
 * Newer Nutshell mints issue "v2" keyset IDs (0x01-prefixed). cashu-ts maps
 * those at decode time, so getDecodedToken(token, []) throws "short keyset ID
 * v2…" for their tokens unless the mint's keyset ids are supplied. Escrow
 * callers always know the mint, so on that specific error fetch the keyset
 * list and retry. Cached per mint; failures are not cached.
 */
const mintKeysetIdCache = new Map<string, Promise<string[]>>();

export function fetchMintKeysetIds(mintUrl: string): Promise<string[]> {
  let pending = mintKeysetIdCache.get(mintUrl);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(`${mintUrl}/v1/keysets`);
      if (!response.ok) {
        throw new Error(`Failed to fetch keysets from ${mintUrl}`);
      }
      const body = await response.json();
      const ids = (body?.keysets ?? [])
        .map((keyset: { id?: unknown }) => keyset?.id)
        .filter((id: unknown): id is string => typeof id === "string");
      if (ids.length === 0) {
        throw new Error(`Mint ${mintUrl} returned no keysets`);
      }
      return ids;
    })();
    mintKeysetIdCache.set(mintUrl, pending);
    // Never cache a failure: a transient mint outage must not poison decodes.
    pending.catch(() => mintKeysetIdCache.delete(mintUrl));
  }
  return pending;
}

async function decodeTokenWithKeysets(
  token: string,
  mintUrl?: string
): Promise<Token> {
  try {
    return getDecodedToken(token, []);
  } catch (error) {
    const isShortKeysetIdError =
      error instanceof Error && /short keyset id/i.test(error.message);
    if (!isShortKeysetIdError || !mintUrl) throw error;
    return getDecodedToken(token, await fetchMintKeysetIds(mintUrl));
  }
}

export async function decodeEscrowLockedProofs(
  lockedToken: string,
  mintUrl?: string
): Promise<{
  mint: string;
  proofs: Proof[];
  unit?: string;
}> {
  const decoded = await decodeTokenWithKeysets(lockedToken, mintUrl);
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
  // cashu-ts receive() rejects a token object whose unit is absent (undefined
  // !== "sat"), so callers that re-receive these proofs need the unit.
  return { mint: decoded.mint, proofs, unit: decoded.unit };
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
  signer: unknown,
  mintUrl?: string
): Promise<Proof[]> {
  return signEscrowProofsWithSigner(
    (await decodeEscrowLockedProofs(lockedToken, mintUrl)).proofs,
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
