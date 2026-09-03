// Server-trusted Cashu escrow commitments.
//
// Before the server accepts an escrow registration, the buyer must prove —
// with a signed Nostr event — exactly which seller, order, amount, mint,
// expiry, and (optional) arbiter they are locking funds to. The server
// re-derives every field from the signed tags, requires the content to be a
// canonical rendering of those same fields (so tag/content cannot disagree),
// and checks the mint/arbiter against server-configured allowlists. Only then
// is the registration durably recorded (see utils/db/cashu-escrow-service.ts).

import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools";
import type { NostrEventTemplate } from "@/utils/nostr/nostr-manager";
import {
  getAllowedEscrowMints,
  getEscrowArbiterPubkeys,
  normalizeEscrowMintUrl,
} from "@/utils/cashu/escrow-config";

/** Parameterized-replaceable kind for escrow commitments (unused elsewhere). */
export const ESCROW_COMMITMENT_KIND = 31995;

/**
 * Parameterized-replaceable kind for escrow ACTION requests (refund today;
 * release arrives with the seller/arbiter endpoints). d tag = escrow id.
 */
export const ESCROW_ACTION_KIND = 31996;

/** Commitment events older than this are rejected to bound replay windows. */
export const ESCROW_COMMITMENT_MAX_AGE_SECONDS = 600;

/** Lock periods far in the future are a buyer-error / griefing vector. */
export const ESCROW_MAX_LOCK_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Default lock period offered to buyers at checkout. Comfortably covers
 * typical shipping windows while staying well under the 30-day maximum.
 */
export const ESCROW_DEFAULT_LOCK_SECONDS = 60 * 60 * 24 * 14; // 14 days

export const ESCROW_MAX_ORDER_ID_LENGTH = 128;

const HEX_PUBKEY_REGEX = /^[0-9a-f]{64}$/;

export interface EscrowCommitment {
  buyerPubkey: string;
  sellerPubkey: string;
  orderId: string;
  amountSats: number;
  mintUrl: string;
  expiresAt: number; // unix seconds
  arbiterPubkey?: string;
}

export type EscrowCommitmentVerification =
  | { ok: true; commitment: EscrowCommitment; escrowId: string }
  | { ok: false; error: string };

/** Deterministic, idempotency-safe escrow identity. */
export function deriveEscrowId(buyerPubkey: string, orderId: string): string {
  return `${buyerPubkey}:${orderId}`;
}

/**
 * Read a tag that must appear exactly once with exactly one value. Duplicate
 * or malformed tags are a smuggling vector (a verifier reading the first
 * occurrence while another component reads the second), so they are rejected
 * outright rather than resolved by fiat.
 */
function getUniqueTagValue(
  event: Event,
  tagName: string,
  options: { required: boolean }
): { value?: string; error?: string } {
  const matches = event.tags.filter((tag) => tag[0] === tagName);
  if (matches.length === 0) {
    return options.required
      ? { error: `Escrow commitment is missing the "${tagName}" tag.` }
      : {};
  }
  if (matches.length > 1) {
    return {
      error: `Escrow commitment must not repeat the "${tagName}" tag.`,
    };
  }
  const tag = matches[0];
  if (!tag || tag.length !== 2 || typeof tag[1] !== "string" || tag[1] === "") {
    return { error: `Escrow commitment has a malformed "${tagName}" tag.` };
  }
  return { value: tag[1] };
}

/**
 * Canonical content: fixed key order so the server can recompute the exact
 * string from the signed tags and require byte equality. A commitment whose
 * content and tags disagree is rejected, which closes the "tags say seller A,
 * content says seller B" ambiguity.
 */
export function buildEscrowCommitmentContent(
  commitment: Omit<EscrowCommitment, "buyerPubkey">
): string {
  const payload: Record<string, string | number> = {
    amountSats: commitment.amountSats,
    expiresAt: commitment.expiresAt,
    mintUrl: commitment.mintUrl,
    orderId: commitment.orderId,
    sellerPubkey: commitment.sellerPubkey,
  };
  if (commitment.arbiterPubkey) {
    payload.arbiterPubkey = commitment.arbiterPubkey;
  }
  // JSON.stringify emits keys in insertion order — keep this object literal
  // sorted alphabetically (arbiter slots in first when present).
  const ordered: Record<string, string | number> = {};
  for (const key of Object.keys(payload).sort()) {
    const value = payload[key];
    if (value !== undefined) ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

/** Client-side builder: the buyer signs this template with their signer. */
export function buildEscrowCommitmentEventTemplate(
  commitment: EscrowCommitment
): NostrEventTemplate {
  const escrowId = deriveEscrowId(commitment.buyerPubkey, commitment.orderId);
  const tags: string[][] = [
    ["d", escrowId],
    ["order", commitment.orderId],
    ["seller", commitment.sellerPubkey],
    ["amount", String(commitment.amountSats)],
    ["mint", commitment.mintUrl],
    ["expiration", String(commitment.expiresAt)],
  ];
  if (commitment.arbiterPubkey) {
    tags.push(["arbiter", commitment.arbiterPubkey]);
  }
  return {
    kind: ESCROW_COMMITMENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: buildEscrowCommitmentContent(commitment),
    tags,
  };
}

/**
 * Verify a buyer-signed escrow commitment event against server configuration.
 * Pure apart from the injected allowlists/clock, so it is directly testable.
 */
export function verifyEscrowCommitmentEvent(
  event: Event,
  options?: {
    allowedMints?: ReadonlySet<string>;
    arbiterPubkeys?: ReadonlySet<string>;
    nowSeconds?: number;
  }
): EscrowCommitmentVerification {
  const fail = (error: string): EscrowCommitmentVerification => ({
    ok: false,
    error,
  });

  const allowedMints = options?.allowedMints ?? getAllowedEscrowMints();
  const arbiterPubkeys = options?.arbiterPubkeys ?? getEscrowArbiterPubkeys();
  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!event || event.kind !== ESCROW_COMMITMENT_KIND) {
    return fail("Invalid escrow commitment event kind.");
  }

  if (!verifyEvent(event)) {
    return fail("Invalid escrow commitment signature.");
  }

  // Freshness: a commitment signed long ago must not be replayable.
  if (
    !Number.isFinite(event.created_at) ||
    Math.abs(nowSeconds - event.created_at) > ESCROW_COMMITMENT_MAX_AGE_SECONDS
  ) {
    return fail("Escrow commitment is stale; please sign it again.");
  }

  const orderTag = getUniqueTagValue(event, "order", { required: true });
  const sellerTag = getUniqueTagValue(event, "seller", { required: true });
  const amountTag = getUniqueTagValue(event, "amount", { required: true });
  const mintTag = getUniqueTagValue(event, "mint", { required: true });
  const expiryTag = getUniqueTagValue(event, "expiration", { required: true });
  const arbiterTag = getUniqueTagValue(event, "arbiter", { required: false });
  const dTag = getUniqueTagValue(event, "d", { required: true });
  const tagError =
    orderTag.error ||
    sellerTag.error ||
    amountTag.error ||
    mintTag.error ||
    expiryTag.error ||
    arbiterTag.error ||
    dTag.error;
  if (tagError) {
    return fail(tagError);
  }

  const orderId = orderTag.value;
  const sellerPubkey = sellerTag.value?.toLowerCase();
  const amountRaw = amountTag.value;
  const mintRaw = mintTag.value;
  const expiryRaw = expiryTag.value;
  const arbiterRaw = arbiterTag.value?.toLowerCase();

  if (
    !orderId ||
    orderId.length === 0 ||
    orderId.length > ESCROW_MAX_ORDER_ID_LENGTH
  ) {
    return fail("Escrow commitment is missing a valid order id.");
  }
  if (!sellerPubkey || !HEX_PUBKEY_REGEX.test(sellerPubkey)) {
    return fail("Escrow commitment is missing a valid seller pubkey.");
  }
  const amountSats = Number(amountRaw);
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    return fail("Escrow commitment is missing a valid amount.");
  }
  const mintUrl = mintRaw ? normalizeEscrowMintUrl(mintRaw) : null;
  if (!mintUrl) {
    return fail("Escrow commitment is missing a valid mint URL.");
  }
  const expiresAt = Number(expiryRaw);
  if (!Number.isSafeInteger(expiresAt)) {
    return fail("Escrow commitment is missing a valid expiry.");
  }
  if (expiresAt <= nowSeconds) {
    return fail("Escrow commitment has already expired.");
  }
  if (expiresAt > nowSeconds + ESCROW_MAX_LOCK_SECONDS) {
    return fail("Escrow lock period exceeds the maximum allowed duration.");
  }
  if (arbiterRaw !== undefined && !HEX_PUBKEY_REGEX.test(arbiterRaw)) {
    return fail("Escrow commitment has an invalid arbiter pubkey.");
  }

  // Allowlist gates — only configured mints and arbiters are accepted.
  if (!allowedMints.has(mintUrl)) {
    return fail("Escrow mint is not in the configured allowlist.");
  }
  if (arbiterRaw && !arbiterPubkeys.has(arbiterRaw)) {
    return fail("Escrow arbiter is not in the configured allowlist.");
  }

  const escrowId = deriveEscrowId(event.pubkey, orderId!);
  if (dTag.value !== escrowId) {
    return fail("Escrow commitment id does not match buyer and order.");
  }

  // Content must be the canonical rendering of the signed tags so no field
  // can disagree between machine-readable tags and displayable content.
  const expectedContent = buildEscrowCommitmentContent({
    sellerPubkey,
    orderId,
    amountSats,
    mintUrl,
    expiresAt,
    arbiterPubkey: arbiterRaw,
  });
  if (event.content !== expectedContent) {
    return fail("Escrow commitment content does not match its signed tags.");
  }

  return {
    ok: true,
    escrowId,
    commitment: {
      buyerPubkey: event.pubkey,
      sellerPubkey,
      orderId,
      amountSats,
      mintUrl,
      expiresAt,
      arbiterPubkey: arbiterRaw,
    },
  };
}

// ── Escrow action requests (refund today, release later) ────────────────────
//
// An action event is the actor's signed instruction to the payout pipeline.
// Only "refund" exists for now — the buyer asks the server to enqueue their
// refund once the lock has expired. Seller/arbiter "release" arrives with the
// signed release endpoints (see docs/cashu-escrow-threat-model.md checklist).

export const ESCROW_ACTIONS = ["refund", "release"] as const;
export type EscrowAction = (typeof ESCROW_ACTIONS)[number];

export interface EscrowActionRequest {
  action: EscrowAction;
  escrowId: string;
}

export type EscrowActionVerification =
  | { ok: true; action: EscrowAction; escrowId: string; actorPubkey: string }
  | { ok: false; error: string };

/**
 * Canonical content for an action event, re-derived server-side from the
 * signed tags (same tag/content anti-disagreement rule as commitments).
 */
export function buildEscrowActionContent(request: EscrowActionRequest): string {
  // JSON.stringify emits keys in insertion order — keep alphabetically sorted.
  return JSON.stringify({ action: request.action, escrowId: request.escrowId });
}

/** Client-side builder: the actor signs this template with their signer. */
export function buildEscrowActionEventTemplate(
  request: EscrowActionRequest
): NostrEventTemplate {
  return {
    kind: ESCROW_ACTION_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: buildEscrowActionContent(request),
    tags: [
      ["d", request.escrowId],
      ["action", request.action],
    ],
  };
}

/**
 * Verify a signed escrow action event. Refunds are buyer-only, so a refund
 * signer is bound to the escrow id's buyer prefix. A "release" may be signed
 * by EITHER party (the buyer approves, the seller completes) — the endpoints
 * authorize the actor against the registered commitment, which is
 * authoritative. Pure apart from the injected clock, so it is directly
 * testable.
 */
export function verifyEscrowActionEvent(
  event: Event,
  options?: { nowSeconds?: number }
): EscrowActionVerification {
  const fail = (error: string): EscrowActionVerification => ({
    ok: false,
    error,
  });

  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!event || event.kind !== ESCROW_ACTION_KIND) {
    return fail("Invalid escrow action event kind.");
  }
  if (!verifyEvent(event)) {
    return fail("Invalid escrow action signature.");
  }
  if (
    !Number.isFinite(event.created_at) ||
    Math.abs(nowSeconds - event.created_at) > ESCROW_COMMITMENT_MAX_AGE_SECONDS
  ) {
    return fail("Escrow action is stale; please sign it again.");
  }

  const dTag = getUniqueTagValue(event, "d", { required: true });
  const actionTag = getUniqueTagValue(event, "action", { required: true });
  const tagError = dTag.error || actionTag.error;
  if (tagError) return fail(tagError);

  const escrowId = dTag.value!;
  const action = actionTag.value!;
  // escrow id = "<buyer pubkey hex>:<order id>" (see deriveEscrowId).
  if (
    escrowId.length > 64 + 1 + ESCROW_MAX_ORDER_ID_LENGTH ||
    !/^[0-9a-f]{64}:.{1,128}$/.test(escrowId)
  ) {
    return fail("Escrow action has a malformed escrow id.");
  }
  if (!(ESCROW_ACTIONS as readonly string[]).includes(action)) {
    return fail("Unsupported escrow action.");
  }
  // Refunds are buyer-only: the signer must be the committed buyer. Release
  // actors are authorized by the endpoints against the registration.
  if (action === "refund" && !escrowId.startsWith(`${event.pubkey}:`)) {
    return fail("Escrow action signer does not match the escrow buyer.");
  }
  if (
    event.content !==
    buildEscrowActionContent({ action: action as EscrowAction, escrowId })
  ) {
    return fail("Escrow action content does not match its signed tags.");
  }

  return {
    ok: true,
    action: action as EscrowAction,
    escrowId,
    actorPubkey: event.pubkey,
  };
}
