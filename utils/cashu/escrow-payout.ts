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
  /**
   * Set ONLY by the arbiter-resolution endpoint, after it has bound the
   * signer to the registered, allowlisted arbiter — never taken from client
   * input. The worker revalidates every payload before paying out, so this
   * server-attested flag is what lets a directed payout (arbiter +
   * counterparty witness, pre-expiry directed refund) survive the
   * endpoint→worker handoff instead of being re-judged under party rules.
   */
  directedByArbiter?: boolean;
}

export interface EscrowPayoutResult {
  /** Fresh proofs P2PK-locked to the payee — recorded on the outbox row. */
  outputs: Proof[];
}

/** The slice of a Cashu wallet the executor needs (injectable for tests). */
export type EscrowPayoutMintWallet = Pick<
  CashuWallet,
  "checkProofsStates" | "prepareSwapToReceive" | "completeSwap" | "loadMint"
>;

/** The slice of a Cashu mint client the recovery path needs. */
export type EscrowPayoutMintApi = Pick<CashuMint, "restore" | "getKeys">;

export type EscrowWalletFactory = (mintUrl: string) => EscrowPayoutMintWallet;

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
  persistPreparedOutputs?: (prepared: SerializedOutputData[]) => Promise<void>;
}

/**
 * P2PK lock pubkeys may be x-only (64 hex, as in the Nostr commitment) or
 * compressed (66 hex with a 02/03 prefix, as mints commonly emit). Compare
 * on the x-only form.
 */
export function normalizeP2PKPubkey(pubkey: string): string {
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
 * The only P2PK tags this worker knows how to pay. NUT-11 tags are
 * semantics-bearing at the mint, so an unrecognized tag is never safe to
 * ignore. `pubkeys` is admitted ONLY for the committed-arbiter construction
 * (strictly validated below) — anything else that would silently widen the
 * spender set still fails closed.
 */
const ALLOWED_P2PK_TAGS = new Set([
  "locktime",
  "refund",
  "pubkeys",
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
 *   sigflag absent or SIG_INPUTS (SIG_ALL would require signing outputs,
 *           which the keyless server cannot do)
 *   no other tags (see ALLOWED_P2PK_TAGS)
 * When the commitment names NO arbiter:
 *   n_sigs / n_sigs_refund absent or 1, and no `pubkeys` tag (1-of-1 seller
 *   lock with a buyer refund path).
 * When the commitment names an arbiter (2-of-3 tiebreaker):
 *   pubkeys = exactly {buyer, arbiter} and n_sigs = 2, so a dispute can be
 *   resolved by the arbiter co-signing with either party — never weaker than
 *   the plain construction (no extra spenders, refund path unchanged).
 *
 * options.directedByArbiter marks the dispute-resolution path: the witness
 * must then include the arbiter (plus a counterparty), and a directed REFUND
 * is allowed before expiry (the dispute case is a seller gone unresponsive;
 * the 2-of-3 witness replaces the timelock as the authorization).
 */
export function validateEscrowPayoutProofs(
  registration: EscrowRegistration,
  action: EscrowOutboxAction,
  proofs: Proof[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
  options?: { requireWitness?: boolean; directedByArbiter?: boolean }
): void {
  const expiresAtSeconds = Math.floor(registration.expiresAt.getTime() / 1000);
  const arbiterPubkey = registration.arbiterPubkey
    ? normalizeP2PKPubkey(registration.arbiterPubkey)
    : null;
  const directedByArbiter = options?.directedByArbiter === true && !!arbiterPubkey;

  // Re-check the lock window at signing time (threat model: expiry race).
  // A release enqueued before expiry must not pay the seller once the
  // buyer's refund window has opened (even an arbiter-directed one — the
  // arbiter can direct a refund instead), and a party refund must not pay
  // early.
  if (action === "release" && nowSeconds >= expiresAtSeconds) {
    throw new Error(
      "Escrow lock has expired; a release can no longer be paid out."
    );
  }
  if (action === "refund" && nowSeconds < expiresAtSeconds && !directedByArbiter) {
    throw new Error("Escrow lock has not expired; refusing to refund early.");
  }

  // Who must witness depends on the construction and who is directing:
  //   release, no arbiter              → seller
  //   release, arbiter, party path     → seller AND (buyer OR arbiter)
  //   release, arbiter-directed        → arbiter AND (buyer OR seller)
  //   refund, party path               → buyer (refund key; the mint itself
  //                                      enforces the locktime)
  //   refund, arbiter-directed         → arbiter AND buyer
  const witnessOk = (proof: Proof): boolean => {
    const has = (pk: string) => hasP2PKSignedProof(pk, proof);
    if (action === "release") {
      if (!arbiterPubkey) return has(registration.sellerPubkey);
      if (directedByArbiter) {
        return (
          has(arbiterPubkey) &&
          (has(registration.buyerPubkey) || has(registration.sellerPubkey))
        );
      }
      return (
        has(registration.sellerPubkey) &&
        (has(registration.buyerPubkey) || has(arbiterPubkey))
      );
    }
    if (directedByArbiter) return has(arbiterPubkey) && has(registration.buyerPubkey);
    return has(registration.buyerPubkey);
  };
  const witnessError =
    action === "release"
      ? directedByArbiter
        ? "Escrow resolution proof must be witnessed by the arbiter and one party."
        : arbiterPubkey
          ? "Escrow release proof must be witnessed by the seller and one other party."
          : "Escrow release proof is not signed by the seller."
      : directedByArbiter
        ? "Escrow resolution proof must be witnessed by the arbiter and the buyer."
        : "Escrow refund proof is not signed by the buyer.";

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

    const pubkeysTag = getUniqueTagValues(secret.tags, "pubkeys");
    const nSigs = getUniqueTagValues(secret.tags, "n_sigs");
    const nSigsRefund = getUniqueTagValues(secret.tags, "n_sigs_refund");
    if (nSigs === null || nSigsRefund === null) {
      throw new Error("Escrow payout proof has a duplicate multisig tag.");
    }
    if (arbiterPubkey) {
      // Committed-arbiter construction: 2-of-3 {seller, buyer, arbiter}. The
      // data key is the seller (checked above); the pubkeys tag must be
      // exactly {buyer, arbiter} and n_sigs exactly 2 — anything weaker, or
      // a substituted second spender, fails closed.
      const set = (pubkeysTag ?? []).map(normalizeP2PKPubkey).sort();
      const want = [registration.buyerPubkey, arbiterPubkey]
        .map(normalizeP2PKPubkey)
        .sort();
      if (
        pubkeysTag === null ||
        pubkeysTag === undefined ||
        set.length !== 2 ||
        set[0] !== want[0] ||
        set[1] !== want[1]
      ) {
        throw new Error(
          "Escrow payout proof does not match the committed 2-of-3 arbiter lock."
        );
      }
      if (!nSigs || nSigs.length !== 1 || nSigs[0] !== "2") {
        throw new Error(
          "Escrow payout proof must require exactly 2 signatures for the committed arbiter lock."
        );
      }
      if (nSigsRefund && (nSigsRefund.length !== 1 || nSigsRefund[0] !== "1")) {
        throw new Error("Escrow payout proof weakens the buyer's refund path.");
      }
    } else {
      if (pubkeysTag !== undefined) {
        throw new Error(
          "Escrow payout proof adds spenders the commitment never named."
        );
      }
      if (
        (nSigs && (nSigs.length !== 1 || nSigs[0] !== "1")) ||
        (nSigsRefund && (nSigsRefund.length !== 1 || nSigsRefund[0] !== "1"))
      ) {
        throw new Error(
          "Escrow payout proof uses a multisig construction this worker cannot pay."
        );
      }
    }

    const sigflag = getUniqueTagValues(secret.tags, "sigflag");
    if (sigflag === null || (sigflag && sigflag[0] !== "SIG_INPUTS")) {
      throw new Error(
        "Escrow payout proof uses SIG_ALL, which the keyless server cannot spend."
      );
    }

    // The witness must satisfy the path's signature rule over each proof's
    // secret (verified with the real cashu-ts verifier, so library semantics
    // are the contract). Skipped ONLY for the structural pre-check when the
    // buyer hands RAW proofs over for the seller to witness (release-approve)
    // — every payout path requires them.
    if (options?.requireWitness !== false && !witnessOk(proof)) {
      throw new Error(witnessError);
    }
  }

  if (total < registration.amountSats) {
    throw new Error("Escrow payout proofs do not cover the committed amount.");
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
  const parsed = assertPayloadShape(payload);
  const proofs = parsed.proofs;
  // directedByArbiter is server-attested (written by the resolve endpoint,
  // persisted on the outbox row) — thread it into this revalidation or the
  // directed payout the endpoint already authorized would be re-judged under
  // party rules and silently rejected at payout time.
  validateEscrowPayoutProofs(registration, action, proofs, options?.nowSeconds, {
    directedByArbiter: parsed.directedByArbiter === true,
  });

  const walletFactory = options?.walletFactory ?? defaultWalletFactory;
  const wallet = walletFactory(registration.mintUrl);
  // cashu-ts v4 wallets throw "KeyChain not initialized" until the mint's
  // keys/keysets are loaded — every op below needs them.
  await wallet.loadMint();

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
