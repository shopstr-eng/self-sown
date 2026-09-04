// Backup & restore for the buyer's escrow-locked proofs.
//
// CUSTODY (docs/cashu-escrow-threat-model.md, residual risk #1): the
// P2PK-locked proofs live only in the buyer's localStorage escrow record.
// To survive a lost browser, the locked proofs are ALSO published to the
// buyer's own kind-7375 wallet backup at checkout time, tagged with an
// `escrow` marker carrying the record metadata. Two deliberate differences
// from ordinary wallet proof events:
//
//  1. NO spending-history event is published and the boot fetch
//     (fetchCashuWallet) excludes escrow-marked events from the spendable
//     `cashuProofs` set — locked proofs are NOT wallet balance (the buyer
//     cannot spend them before expiry; the seller key can).
//  2. Restore routes them back into `cashu_escrows` records (never into
//     `tokens`), verifying every proof UNSPENT against its mint first
//     (fail-closed per the restore-from-backup rules) and requiring the FULL
//     locked set — a partial restore would fail the payout validator's
//     exact-amount check, so it is reported as unrecoverable instead.

import { getEncodedToken, type Proof } from "@cashu/cashu-ts";
import type { EventTemplate } from "nostr-tools";
import {
  decodeEscrowLockedProofs,
  listBuyerEscrows,
  recordBuyerEscrow,
  type BuyerEscrowRecord,
} from "@/utils/cashu/escrow-checkout";
import { normalizeP2PKPubkey } from "@/utils/cashu/escrow-payout";
import {
  filterUnspentProofs,
  type ProofEventLike,
} from "@/utils/cashu/wallet-mint-sync";
import { proofAmountToNumber } from "@/utils/cashu/proof-amount";
import { finalizeAndSendNostrEvent } from "@/utils/nostr/nostr-helper-functions";

type Nostr = Parameters<typeof finalizeAndSendNostrEvent>[1];
type Signer = Parameters<typeof finalizeAndSendNostrEvent>[0];

/** Record metadata embedded in the encrypted kind-7375 backup content. */
export interface EscrowBackupInfo {
  escrowId: string;
  orderId: string;
  sellerPubkey: string;
  amountSats: number;
  /** unix seconds */
  expiresAt: number;
  /** unix seconds */
  createdAt: number;
}

function isEscrowBackupInfo(raw: unknown): raw is EscrowBackupInfo {
  const info = raw as EscrowBackupInfo | null | undefined;
  return (
    !!info &&
    typeof info.escrowId === "string" &&
    typeof info.orderId === "string" &&
    typeof info.sellerPubkey === "string" &&
    typeof info.amountSats === "number" &&
    typeof info.expiresAt === "number" &&
    typeof info.createdAt === "number"
  );
}

/**
 * Structural sanity check that a backup's proofs are the P2PK lock its
 * metadata describes: every proof locks to the seller (primary key) with
 * locktime === the escrow expiry. The events are self-authored and encrypted
 * to self, so this is defense-in-depth against a malformed/tampered backup —
 * NOT a substitute for the payout worker's full validator.
 */
function proofsMatchEscrowInfo(
  proofs: Proof[],
  info: EscrowBackupInfo
): boolean {
  if (proofs.length === 0) return false;
  let total = 0;
  for (const proof of proofs) {
    if (!proof || typeof proof.secret !== "string") return false;
    try {
      const parsed = JSON.parse(proof.secret);
      if (!Array.isArray(parsed) || parsed[0] !== "P2PK") return false;
      const payload = parsed[1];
      // Mints emit the lock pubkey in compressed SEC form (02/03-prefixed)
      // while the record carries the x-only Nostr pubkey — compare x-only.
      if (
        typeof payload?.data !== "string" ||
        normalizeP2PKPubkey(payload.data) !== info.sellerPubkey
      )
        return false;
      const tags: string[][] = Array.isArray(payload?.tags) ? payload.tags : [];
      const locktime = tags.find((t) => t[0] === "locktime")?.[1];
      if (Number(locktime) !== info.expiresAt) return false;
    } catch {
      return false;
    }
    total += proofAmountToNumber(proof);
  }
  // The payout validator requires the locked set to sum to the committed
  // amount exactly — a backup that doesn't can never complete a payout.
  return total === info.amountSats;
}

/** Why an escrow backup publish did not complete. */
export type EscrowBackupFailure =
  /** No nostr manager or signer — nothing to publish with (retryable). */
  | "unavailable"
  /**
   * signer.encrypt rejected. Key-based and NIP-07 signers always support
   * NIP-44 here (the NIP-07 constructor requires it), but a remote (NIP-46)
   * signer depends on its bunker: nip04-only bunkers and denied permissions
   * reject the nip44_encrypt RPC, so the backup can NEVER succeed — the
   * buyer must be told their escrow has no recovery backup.
   */
  | "encryption_failed"
  /** Signing/publishing the backup event failed (retryable). */
  | "publish_failed";

export interface EscrowBackupPublishResult {
  published: boolean;
  failure?: EscrowBackupFailure;
}

/**
 * Buyer-facing warning for a missing escrow recovery backup. Shared by the
 * checkout cards and the wallet pages so the buyer sees the same message
 * wherever the failure surfaces.
 */
export function describeEscrowBackupWarning(
  failure: EscrowBackupFailure
): string {
  if (failure === "encryption_failed") {
    return (
      "Your escrowed payment has no recovery backup: your signer could not " +
      "encrypt it (remote signers/bunkers need NIP-44 encryption support). " +
      "Your funds are safe on this device, but if you lose this browser " +
      "before the escrow expires you may be unable to recover them."
    );
  }
  return (
    "Your escrowed payment could not be backed up for recovery yet. Your " +
    "funds are safe on this device; the wallet page will keep retrying the " +
    "backup."
  );
}

/**
 * Whether a signer.encrypt rejection means the signer can NEVER encrypt a
 * backup (the bunker doesn't implement or forbids nip44_encrypt) versus a
 * retryable transport error. NIP-46 bunkers report capability/permission
 * failures only as free-form error strings, so this matches on message
 * text. Only permanent failures may be session-cached as un-retryable.
 */
function isPermanentEncryptionFailure(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /unsupported|unknown method|not implemented|not supported|method not found|permission|denied|restricted|unauthorized|forbidden|blocked/.test(
    msg
  );
}

/**
 * Publish the buyer-retained locked proofs to the buyer's own kind-7375
 * wallet backup, tagged with the escrow record metadata so a restore can
 * rebuild the `cashu_escrows` record. Best-effort: never throws (the
 * localStorage record written at checkout remains the primary custody
 * copy), but returns a typed failure so callers MUST surface it — a backup
 * that silently never publishes leaves a lost browser unrecoverable.
 */
export async function publishEscrowBackup(
  nostr: Nostr | undefined,
  signer: Signer | undefined,
  record: BuyerEscrowRecord
): Promise<EscrowBackupPublishResult> {
  // Best-effort by design: without a nostr manager or signer there is
  // nothing to publish with — the wallet page retries on next visit.
  if (!nostr || !signer) return { published: false, failure: "unavailable" };
  try {
    const { mint, proofs } = await decodeEscrowLockedProofs(
      record.lockedToken,
      record.mintUrl
    );
    const info: EscrowBackupInfo = {
      escrowId: record.escrowId,
      orderId: record.orderId,
      sellerPubkey: record.sellerPubkey,
      amountSats: record.amountSats,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    };
    const userPubkey = await signer.getPubKey?.();
    let content: string;
    try {
      content = await signer.encrypt(
        userPubkey,
        JSON.stringify({ mint, unit: "sat", proofs, escrow: info })
      );
    } catch (err) {
      // Only a demonstrated capability/permission rejection is permanent
      // (encryption_failed, session-cached as un-retryable). Anything else —
      // bunker timeout, disconnect, unknown error — is retryable and must
      // classify publish_failed so the self-heal keeps trying.
      if (isPermanentEncryptionFailure(err)) {
        console.warn(
          `[escrow-backup] signer could not encrypt the backup for escrow ` +
            `${record.escrowId} (remote signer without NIP-44?):`,
          err
        );
        return { published: false, failure: "encryption_failed" };
      }
      console.warn(
        `[escrow-backup] encrypt attempt for escrow ${record.escrowId} ` +
          "failed transiently; the wallet page will retry:",
        err
      );
      return { published: false, failure: "publish_failed" };
    }
    const backupEvent: EventTemplate = {
      kind: 7375,
      tags: [],
      content,
      created_at: Math.floor(Date.now() / 1000),
    };
    // finalizeAndSendNostrEvent caches the signed event to the database
    // before relay publishing, so the backup survives relay outages.
    const signed = await finalizeAndSendNostrEvent(signer, nostr, backupEvent);
    if (!signed) return { published: false, failure: "publish_failed" };
    return { published: true };
  } catch (err) {
    console.warn(
      `[escrow-backup] failed to back up escrow ${record.escrowId}; ` +
        "the wallet page will retry on next visit:",
      err
    );
    return { published: false, failure: "publish_failed" };
  }
}

// Session-local in-flight guard so a re-render loop (proofEvents identity
// churn) can't stack duplicate publishes of the same backup before the
// refreshed proof events arrive. Scoped PER SIGNER like the give-up cache:
// a replacement signer must never be blocked by its predecessor's still-
// pending attempt — production has no mechanism to re-run the effect when
// the old signer's operation settles, so the new signer publishes
// immediately (a rare duplicate backup event is benign: restore takes the
// latest per escrow).
const backupPublishInFlight = new WeakMap<object, Set<string>>();

// Session-local give-up cache, keyed by the SIGNER OBJECT that produced the
// failure: a record whose backup failed with encryption_failed can NEVER
// publish with that signer (nip04-only bunker or denied permission), so
// retrying just re-fires a futile nip44_encrypt RPC — and a possible user-
// facing bunker permission prompt — on every wallet visit and proofEvents
// change. Skipped records still report as unbacked so the warning banner
// stays visible. Transient failures (publish_failed/unavailable) are NOT
// cached and keep retrying.
// Per-signer binding matters twice: a mid-session signer swap (bunker →
// local keys) gets a fresh attempt, and a failure completing AFTER a swap
// lands on the signer that actually produced it, never the replacement.
// WeakMap so abandoned signers' entries are garbage-collected.
const backupPublishGaveUp = new WeakMap<object, Set<string>>();

export interface UnbackedEscrow {
  escrowId: string;
  orderId: string;
  failure: EscrowBackupFailure;
}

export interface EscrowBackupRepublishResult {
  published: number;
  /** Local escrow records still missing a backup after this run. */
  unbacked: UnbackedEscrow[];
}

/**
 * Self-heal: re-publish backups for any local escrow record that has no
 * escrow-marked kind-7375 event yet (e.g. the checkout-time publish failed,
 * or the escrow predates backups). Publishes serially; never throws.
 * Records that remain unbacked are reported with their failure reason so
 * the wallet UI can warn the buyer instead of failing silently. A record
 * whose publish permanently failed (encryption_failed) is not retried for
 * the rest of the page-load session — the signer can never make that backup
 * — but it still reports as unbacked so the warning stays up.
 */
export async function republishMissingEscrowBackups(
  nostr: Nostr | undefined,
  signer: Signer | undefined,
  proofEvents: ProofEventLike[]
): Promise<EscrowBackupRepublishResult> {
  const result: EscrowBackupRepublishResult = { published: 0, unbacked: [] };
  if (typeof window === "undefined" || !nostr || !signer) return result;
  // Give-ups are bound to the signer that produced them. The set is fetched
  // (or created) once per run and CAPTURED by the async publish below, so a
  // failure completing after a mid-flight signer swap binds to the signer
  // that actually produced it — never to the replacement signer.
  let gaveUpForSigner = backupPublishGaveUp.get(signer);
  if (!gaveUpForSigner) {
    gaveUpForSigner = new Set<string>();
    backupPublishGaveUp.set(signer, gaveUpForSigner);
  }
  let inFlightForSigner = backupPublishInFlight.get(signer);
  if (!inFlightForSigner) {
    inFlightForSigner = new Set<string>();
    backupPublishInFlight.set(signer, inFlightForSigner);
  }
  const backedUp = new Set<string>();
  for (const ev of proofEvents || []) {
    if (isEscrowBackupInfo(ev?.escrow)) backedUp.add(ev.escrow.escrowId);
  }
  for (const record of listBuyerEscrows()) {
    if (backedUp.has(record.escrowId)) continue;
    if (gaveUpForSigner.has(record.escrowId)) {
      // Permanent failure with THIS signer — don't re-prompt it, but keep
      // the record visible as unbacked so the warning banner stays up.
      result.unbacked.push({
        escrowId: record.escrowId,
        orderId: record.orderId,
        failure: "encryption_failed",
      });
      continue;
    }
    if (inFlightForSigner.has(record.escrowId)) continue;
    inFlightForSigner.add(record.escrowId);
    try {
      const publishResult = await publishEscrowBackup(nostr, signer, record);
      if (publishResult.published) {
        result.published += 1;
      } else {
        if (publishResult.failure === "encryption_failed") {
          // Binds to the captured per-signer set: if a signer swap happened
          // while this encrypt RPC was in flight, the failure is recorded
          // against THIS signer, not whichever signer is current now.
          gaveUpForSigner.add(record.escrowId);
        }
        result.unbacked.push({
          escrowId: record.escrowId,
          orderId: record.orderId,
          failure: publishResult.failure ?? "publish_failed",
        });
      }
    } finally {
      inFlightForSigner.delete(record.escrowId);
    }
  }
  return result;
}

export type UnrecoveredEscrowReason =
  /** Mint could not be probed — retry later; the backup persists. */
  | "mint_unreachable"
  /** The mint reports locked proofs SPENT, or the local write failed. */
  | "proofs_spent"
  /** Backup content doesn't match a well-formed escrow lock. */
  | "invalid_backup";

export interface UnrecoveredEscrow extends EscrowBackupInfo {
  mintUrl: string;
  reason: UnrecoveredEscrowReason;
}

export interface EscrowRestoreResult {
  restoredEscrowCount: number;
  restoredEscrowSats: number;
  unrecoveredEscrows: UnrecoveredEscrow[];
}

/**
 * Rebuild `cashu_escrows` records from escrow-marked kind-7375 backup
 * events. Merge-only: escrows already recorded locally (the buyer still has
 * custody) are skipped. Each candidate's proofs are verified UNSPENT against
 * their mint first — fail-closed: an unreachable mint SKIPS the escrow (the
 * backup persists on relays/Postgres for a retry) and spent proofs are
 * reported as unrecoverable rather than resurrected.
 */
export async function restoreEscrowsFromProofEvents(
  proofEvents: ProofEventLike[]
): Promise<EscrowRestoreResult> {
  const empty: EscrowRestoreResult = {
    restoredEscrowCount: 0,
    restoredEscrowSats: 0,
    unrecoveredEscrows: [],
  };
  if (typeof window === "undefined") return empty;

  // Newest backup event per escrow id.
  const latestByEscrow = new Map<
    string,
    { info: EscrowBackupInfo; mint: string; proofs: Proof[]; createdAt: number }
  >();
  for (const ev of proofEvents || []) {
    if (!ev || !isEscrowBackupInfo(ev.escrow)) continue;
    if (!ev.mint || !Array.isArray(ev.proofs) || ev.proofs.length === 0)
      continue;
    const existing = latestByEscrow.get(ev.escrow.escrowId);
    if (existing && existing.createdAt >= (ev.created_at ?? 0)) continue;
    latestByEscrow.set(ev.escrow.escrowId, {
      info: ev.escrow,
      mint: ev.mint,
      proofs: ev.proofs,
      createdAt: ev.created_at ?? 0,
    });
  }
  if (latestByEscrow.size === 0) return empty;

  // Skip escrows the buyer still holds locally — custody is intact.
  const held = new Set(listBuyerEscrows().map((r) => r.escrowId));

  const restored: BuyerEscrowRecord[] = [];
  const unrecovered: UnrecoveredEscrow[] = [];
  for (const { info, mint, proofs } of latestByEscrow.values()) {
    if (held.has(info.escrowId)) continue;
    const report = (reason: UnrecoveredEscrowReason) =>
      unrecovered.push({ ...info, mintUrl: mint, reason });

    if (!proofsMatchEscrowInfo(proofs, info)) {
      report("invalid_backup");
      continue;
    }

    // Verify the full locked set is UNSPENT before restoring. Fail-closed:
    // an unreachable mint skips the escrow (retryable), and any SPENT proof
    // means the locked set is incomplete (a payout needs the exact amount),
    // so it is reported rather than partially restored.
    const { spentCount, checked } = await filterUnspentProofs(mint, proofs);
    if (!checked) {
      report("mint_unreachable");
      continue;
    }
    if (spentCount > 0) {
      report("proofs_spent");
      continue;
    }

    const record: BuyerEscrowRecord = {
      escrowId: info.escrowId,
      orderId: info.orderId,
      sellerPubkey: info.sellerPubkey,
      amountSats: info.amountSats,
      mintUrl: mint,
      expiresAt: info.expiresAt,
      createdAt: info.createdAt,
      lockedToken: getEncodedToken({ mint, proofs }),
      // Record the locked secrets so spendable-wallet reconciliation never
      // has to decode the token (v2-keyset mints can't decode synchronously).
      lockedSecrets: proofs
        .map((proof) => proof?.secret)
        .filter((secret): secret is string => typeof secret === "string"),
    };
    // recordBuyerEscrow re-reads storage and dedupes by escrow id, so a
    // concurrent checkout/write can't be clobbered. A failed write is
    // retryable (the backup persists), so report it like an unreachable mint.
    if (recordBuyerEscrow(record)) restored.push(record);
    else report("mint_unreachable");
  }

  return {
    restoredEscrowCount: restored.length,
    restoredEscrowSats: restored.reduce((acc, r) => acc + r.amountSats, 0),
    unrecoveredEscrows: unrecovered,
  };
}

/**
 * Human-readable escrow-restore summary for the wallet restore status line.
 * Unrecoverable escrows get an explicit "contact support before expiry"
 * pointer — after expiry the buyer can self-refund, so the deadline is what
 * matters.
 */
export function describeEscrowRestore(result: EscrowRestoreResult): string {
  const notes: string[] = [];
  if (result.restoredEscrowCount > 0) {
    notes.push(
      `Restored ${result.restoredEscrowCount} escrowed payment${
        result.restoredEscrowCount === 1 ? "" : "s"
      } (${result.restoredEscrowSats} sats).`
    );
  }
  const retryable = result.unrecoveredEscrows.filter(
    (e) => e.reason === "mint_unreachable"
  );
  if (retryable.length > 0) {
    notes.push(
      `${retryable.length} escrowed payment${
        retryable.length === 1 ? "" : "s"
      } couldn't be verified — a mint was unreachable. Try again in a moment.`
    );
  }
  const lost = result.unrecoveredEscrows.filter(
    (e) => e.reason !== "mint_unreachable"
  );
  for (const escrow of lost) {
    notes.push(
      `Escrowed payment for order ${escrow.orderId} (${escrow.amountSats} sats, expires ${new Date(
        escrow.expiresAt * 1000
      ).toLocaleDateString()}) could not be recovered — contact support before it expires.`
    );
  }
  return notes.join(" ");
}
