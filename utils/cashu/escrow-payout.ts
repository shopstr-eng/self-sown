// Executes the actual mint payout for a claimed escrow outbox entry.
//
// This module is the ONLY code path that moves escrowed funds. The server
// never holds keys: the P2PK-locked input proofs arrive pre-signed (witness
// attached) by the party entitled to the funds — the seller for a release,
// the buyer for a refund after the lock has expired. The worker submits the
// swap at the mint and locks the outputs to the payee's pubkey, so even the
// freshly minted outputs are useless to anyone but the payee.
//
// Exactly-once + durability discipline (docs/cashu-escrow-threat-model.md):
//
//   1. Before EVERY payment attempt (first or retry) the mint is interrogated
//      via checkProofsStates and the swap runs only when the mint confirms
//      every input UNSPENT. The outbox fencing token alone cannot make an
//      external mint call exactly-once — a worker can crash after the mint
//      swapped the proofs but before finalizing.
//   2. The swap is two-phase: prepareSwapToReceive builds the payee-locked
//      outputs, they are PERSISTED to the outbox row (fenced by the claim
//      token) BEFORE completeSwap touches the mint. If a retry then finds
//      the inputs SPENT, the payout is not lost: the persisted blinded
//      messages are re-presented to the mint's NUT-09 /restore endpoint,
//      which returns the blind signatures for the already-issued outputs,
//      and the payee's proofs are reconstructed. Only when inputs are SPENT
//      *and* no prepared outputs were recorded does the executor refuse
//      (loudly, for operator reconciliation) instead of re-paying.

import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  OutputData,
  hasP2PKSignedProof,
  type Proof,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
  type SerializedOutputData,
} from "@cashu/cashu-ts";
import type {
  EscrowOutboxAction,
  EscrowRegistration,
} from "@/utils/db/cashu-escrow-service";

/** The signed payout payload carried on the outbox row. */
export interface EscrowPayoutPayload {
  proofs: Proof[];
}

export interface EscrowPayoutResult {
  /** Fresh proofs P2PK-locked to the payee — recorded on the outbox row. */
  outputs: Proof[];
}

/** The slice of a Cashu wallet the executor needs (injectable for tests). */
export type EscrowPayoutMintWallet = Pick<
  CashuWallet,
  "checkProofsStates" | "prepareSwapToReceive" | "completeSwap"
>;

/** The slice of a Cashu mint client the recovery path needs. */
export type EscrowPayoutMintApi = Pick<CashuMint, "restore" | "getKeys">;

export type EscrowWalletFactory = (
  mintUrl: string
) => EscrowPayoutMintWallet;

export type EscrowMintApiFactory = (mintUrl: string) => EscrowPayoutMintApi;

const defaultWalletFactory: EscrowWalletFactory = (mintUrl) =>
  new CashuWallet(new CashuMint(mintUrl));

const defaultMintApiFactory: EscrowMintApiFactory = (mintUrl) =>
  new CashuMint(mintUrl);

export interface EscrowPayoutOptions {
  walletFactory?: EscrowWalletFactory;
  mintApiFactory?: EscrowMintApiFactory;
  nowSeconds?: number;
  /**
   * Prepared outputs persisted by an earlier attempt (crash between the mint
   * swap and finalize). When the mint reports the inputs SPENT, these are
   * used to reconstruct the payee's proofs via NUT-09 restore instead of
   * paying again.
   */
  preparedOutputs?: SerializedOutputData[] | null;
  /**
   * REQUIRED durability hook: called with the prepared (payee-locked) output
   * data AFTER the swap is prepared and BEFORE the mint call. Must throw if
   * the data could not be durably recorded — the payment must not proceed
   * with outputs that exist only in process memory.
   */
  persistPreparedOutputs?: (
    prepared: SerializedOutputData[]
  ) => Promise<void>;
}

/**
 * P2PK lock pubkeys may be x-only (64 hex, as in the Nostr commitment) or
 * compressed (66 hex with a 02/03 prefix, as mints commonly emit). Compare
 * on the x-only form.
 */
function normalizeP2PKPubkey(pubkey: string): string {
  const lower = pubkey.toLowerCase();
  if (
    lower.length === 66 &&
    (lower.startsWith("02") || lower.startsWith("03"))
  ) {
    return lower.slice(2);
  }
  return lower;
}

interface ParsedP2PKSecret {
  data: string;
  tags: string[][];
}

function parseP2PKSecret(secret: string): ParsedP2PKSecret | null {
  try {
    const parsed = JSON.parse(secret);
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== "P2PK") {
      return null;
    }
    const payload = parsed[1];
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.data !== "string" || payload.data.length === 0) {
      return null;
    }
    const tags = payload.tags === undefined ? [] : payload.tags;
    if (!Array.isArray(tags)) return null;
    return { data: payload.data, tags };
  } catch {
    return null;
  }
}

function getUniqueTagValues(
  tags: string[][],
  key: string
): string[] | null | undefined {
  const matches = tags.filter((tag) => Array.isArray(tag) && tag[0] === key);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) return null; // duplicate tag — reject
  return matches[0]!.slice(1).map((v) => String(v));
}

/**
 * The only P2PK tags this worker knows how to pay. Anything else — in
 * particular `pubkeys`, which would silently turn a seller-only lock into a
 * 1-of-2 with a second spender — fails closed. NUT-11 tags are
 * semantics-bearing at the mint, so an unrecognized tag is never safe to
 * ignore.
 */
const ALLOWED_P2PK_TAGS = new Set([
  "locktime",
  "refund",
  "n_sigs",
  "n_sigs_refund",
  "sigflag",
]);

function assertPayloadShape(payload: unknown): EscrowPayoutPayload {
  const candidate = payload as EscrowPayoutPayload | null;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !Array.isArray(candidate.proofs) ||
    candidate.proofs.length === 0
  ) {
    throw new Error(
      "Escrow outbox entry has no signed payout proofs attached."
    );
  }
  for (const proof of candidate.proofs) {
    if (
      !proof ||
      typeof proof !== "object" ||
      typeof proof.secret !== "string" ||
      typeof proof.C !== "string" ||
      typeof proof.id !== "string" ||
      typeof proof.amount !== "number" ||
      !Number.isSafeInteger(proof.amount) ||
      proof.amount <= 0
    ) {
      throw new Error("Escrow payout payload contains a malformed proof.");
    }
  }
  return candidate;
}

/**
 * Validate that every payout proof is locked EXACTLY as the registered
 * commitment requires, and signed by the party entitled to this action.
 * Anything else throws — the worker fails closed and never pays out against
 * a lock construction the buyer did not commit to.
 *
 * Required construction (the buyer-side builder must match):
 *   data    = seller pubkey
 *   locktime = commitment expiry (unix seconds)
 *   refund  = exactly [buyer pubkey]
 *   n_sigs / n_sigs_refund absent or 1 (no multisig yet)
 *   sigflag absent or SIG_INPUTS (SIG_ALL would require signing outputs,
 *           which the keyless server cannot do)
 *   no other tags (see ALLOWED_P2PK_TAGS)
 */
export function validateEscrowPayoutProofs(
  registration: EscrowRegistration,
  action: EscrowOutboxAction,
  proofs: Proof[],
  nowSeconds: number = Math.floor(Date.now() / 1000)
): void {
  const expiresAtSeconds = Math.floor(registration.expiresAt.getTime() / 1000);

  // Re-check the lock window at signing time (threat model: expiry race).
  // A release enqueued before expiry must not pay the seller once the
  // buyer's refund window has opened, and a refund must not pay early.
  if (action === "release" && nowSeconds >= expiresAtSeconds) {
    throw new Error(
      "Escrow lock has expired; a release can no longer be paid out."
    );
  }
  if (action === "refund" && nowSeconds < expiresAtSeconds) {
    throw new Error("Escrow lock has not expired; refusing to refund early.");
  }

  const expectedSigner =
    action === "release" ? registration.sellerPubkey : registration.buyerPubkey;

  let total = 0;
  for (const proof of proofs) {
    total += Number(proof.amount);

    const secret = parseP2PKSecret(proof.secret);
    if (!secret) {
      throw new Error("Escrow payout proof is not a P2PK-locked proof.");
    }

    for (const tag of secret.tags) {
      if (
        !Array.isArray(tag) ||
        typeof tag[0] !== "string" ||
        !ALLOWED_P2PK_TAGS.has(tag[0])
      ) {
        throw new Error(
          "Escrow payout proof uses an unsupported P2PK tag; only a plain seller lock with buyer refund is payable."
        );
      }
    }

    if (normalizeP2PKPubkey(secret.data) !== registration.sellerPubkey) {
      throw new Error(
        "Escrow payout proof is not locked to the committed seller."
      );
    }

    const locktime = getUniqueTagValues(secret.tags, "locktime");
    if (
      !locktime ||
      locktime.length !== 1 ||
      locktime[0] !== String(expiresAtSeconds)
    ) {
      throw new Error(
        "Escrow payout proof locktime does not match the commitment expiry."
      );
    }

    const refund = getUniqueTagValues(secret.tags, "refund");
    if (
      !refund ||
      refund.length !== 1 ||
      normalizeP2PKPubkey(refund[0]!) !== registration.buyerPubkey
    ) {
      throw new Error(
        "Escrow payout proof refund key does not match the committed buyer."
      );
    }

    const nSigs = getUniqueTagValues(secret.tags, "n_sigs");
    const nSigsRefund = getUniqueTagValues(secret.tags, "n_sigs_refund");
    if (
      (nSigs && nSigs[0] !== "1") ||
      (nSigsRefund && nSigsRefund[0] !== "1") ||
      nSigs === null ||
      nSigsRefund === null
    ) {
      throw new Error(
        "Escrow payout proof uses a multisig construction this worker cannot pay."
      );
    }

    const sigflag = getUniqueTagValues(secret.tags, "sigflag");
    if (sigflag === null || (sigflag && sigflag[0] !== "SIG_INPUTS")) {
      throw new Error(
        "Escrow payout proof uses SIG_ALL, which the keyless server cannot spend."
      );
    }

    // The witness must carry a valid Schnorr signature from the entitled
    // party over each proof's secret (verified with the real cashu-ts
    // verifier, so library semantics are the contract).
    if (!hasP2PKSignedProof(expectedSigner, proof)) {
      throw new Error(
        action === "release"
          ? "Escrow release proof is not signed by the seller."
          : "Escrow refund proof is not signed by the buyer."
      );
    }
  }

  if (total < registration.amountSats) {
    throw new Error(
      "Escrow payout proofs do not cover the committed amount."
    );
  }
}

/**
 * Reconstruct the payee's proofs after a crash between the mint swap and
 * finalize: the mint's NUT-09 /restore endpoint returns the blind signatures
 * for previously issued blinded messages, and the persisted OutputData
 * (secrets + blinding factors) turns them back into spendable proofs.
 */
async function recoverPreparedOutputs(
  mint: EscrowPayoutMintApi,
  prepared: SerializedOutputData[]
): Promise<Proof[]> {
  const keysetId = prepared[0]!.blindedMessage.id;
  const keysResponse = await mint.getKeys(keysetId);
  const keyset = keysResponse.keysets.find((k) => k.id === keysetId);
  if (!keyset) {
    throw new Error(
      "Escrow payout recovery failed: the mint no longer serves the payout keyset."
    );
  }
  const response = await mint.restore({
    outputs: prepared.map(
      (p): SerializedBlindedMessage => ({
        amount: Number(
          p.blindedMessage.amount
        ) as unknown as SerializedBlindedMessage["amount"],
        id: p.blindedMessage.id,
        B_: p.blindedMessage.B_,
      })
    ),
  });
  // /restore pairs signatures positionally with the outputs it echoes.
  const sigByBlind = new Map<string, SerializedBlindedSignature>();
  response.outputs.forEach((output, index) => {
    const signature = response.signatures[index];
    if (signature) sigByBlind.set(output.B_, signature);
  });
  return prepared.map((p) => {
    const signature = sigByBlind.get(p.blindedMessage.B_);
    if (!signature) {
      throw new Error(
        "Escrow payout recovery failed: the mint did not return every prepared output."
      );
    }
    return OutputData.deserialize(p).toProof(signature, keyset);
  });
}

/**
 * Verify mint proof state and perform the P2PK payout swap. The state check
 * runs before EVERY attempt — including the first — so a retried payout can
 * never double-pay.
 *
 * @throws on any validation or mint failure; the worker records the message
 *         on the outbox row and returns the claim to pending for a retry.
 */
export async function executeEscrowPayout(
  registration: EscrowRegistration,
  action: EscrowOutboxAction,
  payload: unknown,
  options?: EscrowPayoutOptions
): Promise<EscrowPayoutResult> {
  const { proofs } = assertPayloadShape(payload);
  validateEscrowPayoutProofs(registration, action, proofs, options?.nowSeconds);

  const walletFactory = options?.walletFactory ?? defaultWalletFactory;
  const wallet = walletFactory(registration.mintUrl);

  const states = await wallet.checkProofsStates(proofs);
  // Fail closed on an incomplete or mismatched response: we must know the
  // state of EVERY input before moving funds.
  if (!Array.isArray(states) || states.length !== proofs.length) {
    throw new Error(
      "Escrow payout refused: the mint returned an incomplete proof-state response."
    );
  }
  const spent = states.filter((s) => s.state === "SPENT").length;
  const pending = states.filter((s) => s.state === "PENDING").length;
  const unspent = states.filter((s) => s.state === "UNSPENT").length;

  if (spent > 0) {
    if (spent !== proofs.length) {
      // A MIXED state set (some SPENT, some UNSPENT/PENDING/unknown) is an
      // inconsistent or in-flight outcome: the prior swap may be partially
      // applied. NEVER restore-and-finalize and NEVER pay — leave the entry
      // for a later retry, when the mint should report a settled state.
      throw new Error(
        `Escrow payout refused: the mint reports an inconsistent input state (${spent}/${states.length} SPENT); not paying and not recovering.`
      );
    }
    // Every input is SPENT: a previous attempt completed the swap at the
    // mint but crashed before finalizing. NEVER re-pay; reconstruct the
    // payee's outputs from the prepared data persisted before that swap.
    const prepared = options?.preparedOutputs;
    if (prepared && prepared.length > 0) {
      const mintApiFactory = options?.mintApiFactory ?? defaultMintApiFactory;
      const outputs = await recoverPreparedOutputs(
        mintApiFactory(registration.mintUrl),
        prepared
      );
      return { outputs };
    }
    throw new Error(
      `Escrow payout refused: all ${states.length} input proofs are already SPENT at the mint and no prepared outputs were recorded; not paying again.`
    );
  }
  if (pending > 0) {
    throw new Error(
      `Escrow payout deferred: ${pending}/${states.length} input proofs are PENDING in an in-flight swap at the mint.`
    );
  }
  if (unspent !== proofs.length) {
    throw new Error(
      "Escrow payout refused: the mint reported an unrecognized proof state."
    );
  }

  if (!options?.persistPreparedOutputs) {
    // Durability is not optional: without persisted prepared outputs a crash
    // after the swap would burn the payout.
    throw new Error(
      "Escrow payout requires a durable prepared-output persistence hook."
    );
  }

  const payeePubkey =
    action === "release" ? registration.sellerPubkey : registration.buyerPubkey;
  // Inputs carry their witnesses, so the swap needs no private key. The
  // outputs are locked to the payee, so custody of the result is safe.
  const preview = await wallet.prepareSwapToReceive(proofs, undefined, {
    type: "p2pk",
    options: { pubkey: payeePubkey },
  });
  const keepOutputs = preview.keepOutputs ?? [];
  if (keepOutputs.length === 0) {
    throw new Error("Escrow payout swap preparation produced no outputs.");
  }
  const preparedOutputs = keepOutputs.map((output) =>
    OutputData.serialize(output)
  );
  // Persist BEFORE the mint call. If this throws (e.g. the claim was fenced
  // away), the payment must not proceed.
  await options.persistPreparedOutputs(preparedOutputs);

  const { keep } = await wallet.completeSwap(preview);
  if (!keep || keep.length === 0) {
    throw new Error("Escrow payout swap returned no outputs.");
  }
  return { outputs: keep };
}
