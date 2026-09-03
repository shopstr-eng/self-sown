// Buyer-facing escrow status list, rendered on the orders page.
//
// Reads the buyer's localStorage escrow records (written at checkout when
// they opted into escrow — the records also hold the buyer-retained locked
// proofs), polls the public status endpoint for each, and once the lock has
// expired offers a "Request refund" trigger that signs the refund action
// event AND the locked proofs' P2PK witnesses in one click, so the payout
// worker has everything it needs to actually complete the refund. When the
// refund has been paid out, a "Redeem" button swaps the buyer-locked payout
// proofs into the local wallet.

import { useCallback, useContext, useEffect, useState } from "react";
import { nip19 } from "nostr-tools";
import { Mint as CashuMint, Wallet as CashuWallet } from "@cashu/cashu-ts";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { isEscrowClientEnabled } from "@/utils/cashu/escrow-config";
import { buildEscrowActionEventTemplate } from "@/utils/cashu/escrow-commitment";
import {
  BuyerEscrowRecord,
  EscrowStatusResponse,
  decodeEscrowLockedProofs,
  fetchEscrowStatus,
  listBuyerEscrows,
  pruneResolvedBuyerEscrows,
  requestEscrowRefund,
  requestEscrowReleaseApproval,
  signEscrowLockedProofs,
} from "@/utils/cashu/escrow-checkout";
import { persistReceivedTokens } from "@/utils/cashu/wallet-mint-sync";

type EscrowView = {
  record: BuyerEscrowRecord;
  /** null = registered locally but unknown server-side; undefined = loading */
  status: EscrowStatusResponse | null | undefined;
};

function shortNpub(hexPubkey: string): string {
  try {
    const npub = nip19.npubEncode(hexPubkey);
    return `${npub.slice(0, 12)}…${npub.slice(-4)}`;
  } catch {
    return `${hexPubkey.slice(0, 8)}…`;
  }
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function statusChip(view: EscrowView, nowSeconds: number) {
  const { status } = view;
  if (status === undefined) {
    return { label: "Checking…", className: "bg-gray-100 text-gray-700" };
  }
  if (status === null) {
    return { label: "Unknown", className: "bg-gray-100 text-gray-700" };
  }
  if (status.status === "released") {
    return {
      label: "Released to seller",
      className: "bg-green-100 text-green-800",
    };
  }
  if (status.status === "refunded") {
    return { label: "Refunded", className: "bg-blue-100 text-blue-800" };
  }
  if (status.pendingAction === "refund") {
    return status.payloadAttached
      ? {
          label: "Refund pending",
          className: "bg-yellow-100 text-yellow-800",
        }
      : {
          label: "Refund needs your signature",
          className: "bg-orange-100 text-orange-800",
        };
  }
  if (status.pendingAction === "release") {
    if (status.releaseAwaitingSeller) {
      // An ignored release approval never blocks the refund past expiry.
      return status.expiresAt <= nowSeconds
        ? {
            label: "Locked — expired, refundable",
            className: "bg-orange-100 text-orange-800",
          }
        : {
            label: "Release awaiting seller",
            className: "bg-yellow-100 text-yellow-800",
          };
    }
    return {
      label: "Release pending",
      className: "bg-yellow-100 text-yellow-800",
    };
  }
  if (status.expiresAt <= nowSeconds) {
    return {
      label: "Locked — expired, refundable",
      className: "bg-orange-100 text-orange-800",
    };
  }
  return { label: "Locked", className: "bg-purple-100 text-purple-800" };
}

export default function BuyerEscrowList() {
  const { pubkey: userPubkey, signer } = useContext(SignerContext);
  const [views, setViews] = useState<EscrowView[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [redeemedIds, setRedeemedIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const loadRecords = useCallback((): BuyerEscrowRecord[] => {
    if (!userPubkey) return [];
    // Records are keyed `<buyer pubkey>:<order id>`; only show the signed-in
    // buyer their own escrows on this device.
    return listBuyerEscrows().filter((record) =>
      record.escrowId.startsWith(`${userPubkey}:`)
    );
  }, [userPubkey]);

  const refresh = useCallback(async () => {
    const records = loadRecords();
    if (records.length === 0) {
      setViews([]);
      return;
    }
    setViews(records.map((record) => ({ record, status: undefined })));
    const results = await Promise.allSettled(
      records.map((record) => fetchEscrowStatus(record.escrowId))
    );
    const nextViews = records.map((record, index) => {
      const result = results[index]!;
      return {
        record,
        status: result.status === "fulfilled" ? result.value : undefined,
      };
    });
    // Released escrows are terminal — the payout worker spent the locked
    // proofs, so the record is dead weight and safe to prune. (Refunded
    // records are pruned on redeem, in handleRedeem.)
    const releasedIds = nextViews
      .filter((view) => view.status?.status === "released")
      .map((view) => view.record.escrowId);
    if (releasedIds.length > 0) pruneResolvedBuyerEscrows(releasedIds);
    setViews(
      nextViews.filter((view) => !releasedIds.includes(view.record.escrowId))
    );
  }, [loadRecords]);

  useEffect(() => {
    if (!isEscrowClientEnabled()) return;
    void refresh().catch(() => {
      // Status fetch failure is non-fatal: cards render in "Checking…" state.
    });
  }, [refresh]);

  if (!isEscrowClientEnabled() || !userPubkey || views.length === 0) {
    return null;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  const handleRefund = async (view: EscrowView) => {
    if (!signer) return;
    setActionError(null);
    setBusyId(view.record.escrowId);
    try {
      const actionEvent = await signer.sign(
        buildEscrowActionEventTemplate({
          action: "refund",
          escrowId: view.record.escrowId,
        })
      );
      // Attach the buyer-witnessed locked proofs in the same request so the
      // refund can actually be paid out, not just recorded.
      const payoutProofs = await signEscrowLockedProofs(
        view.record.lockedToken,
        signer,
        view.record.mintUrl
      );
      await requestEscrowRefund(actionEvent, payoutProofs);
      await refresh().catch(() => undefined);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Refund request failed."
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleRelease = async (view: EscrowView) => {
    if (!signer) return;
    setActionError(null);
    setBusyId(view.record.escrowId);
    try {
      const actionEvent = await signer.sign(
        buildEscrowActionEventTemplate({
          action: "release",
          escrowId: view.record.escrowId,
        })
      );
      // Hand the RAW locked proofs to the server at stage
      // "awaiting_seller_witness" — only the seller's key can witness them
      // pre-expiry, which is the seller's completion step. The buyer keeps
      // the local record until the release lands (refresh prunes it then).
      const { proofs } = await decodeEscrowLockedProofs(
        view.record.lockedToken,
        view.record.mintUrl
      );
      await requestEscrowReleaseApproval(actionEvent, proofs);
      await refresh().catch(() => undefined);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Release approval failed."
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleRedeem = async (view: EscrowView) => {
    const payoutToken = view.status?.payoutToken;
    if (!signer || !payoutToken) return;
    setActionError(null);
    setBusyId(view.record.escrowId);
    try {
      const decoded = await decodeEscrowLockedProofs(
        payoutToken,
        view.record.mintUrl
      );
      // The payout proofs are P2PK-locked to the buyer: sign the witness,
      // swap them at the mint into ordinary proofs, merge into the wallet.
      const signedProofs = await signEscrowLockedProofs(
        payoutToken,
        signer,
        view.record.mintUrl
      );
      const wallet = new CashuWallet(new CashuMint(decoded.mint));
      await wallet.loadMint();
      const freshProofs = await wallet.receive({
        mint: decoded.mint,
        proofs: signedProofs,
        unit: decoded.unit,
      });
      persistReceivedTokens(freshProofs, decoded.mint);
      setRedeemedIds((prev) => new Set(prev).add(view.record.escrowId));
      // Refunded + redeemed is terminal: the locked token was spent by the
      // refund payout, so the record is safe to drop.
      pruneResolvedBuyerEscrows([view.record.escrowId]);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Redeeming the refund failed."
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h2 className="mb-2 text-lg font-bold text-black">Escrow payments</h2>
      <p className="mb-3 text-sm text-gray-600">
        Cashu payments you chose to lock in escrow. Release them to the seller
        here once your order completes; after the lock date you can reclaim them
        if it never does.
      </p>
      {actionError && (
        <p className="mb-3 rounded-md border-2 border-red-500 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {actionError}
        </p>
      )}
      <ul className="space-y-3">
        {views.map((view) => {
          const chip = statusChip(view, nowSeconds);
          // The control stays available while a pending refund still lacks
          // the buyer's signed payload — e.g. the payload-less entries the
          // expiry sweep auto-enqueues, or after a lost enqueue/claim race —
          // so the buyer can always complete (or retry) the refund.
          const refundable =
            !!signer &&
            view.status != null &&
            view.status.status === "locked" &&
            view.status.expiresAt <= nowSeconds &&
            // A pending release still awaiting the seller's witness converts
            // to a refund at expiry (the refund endpoint does it atomically),
            // so the control stays available; a seller-COMPLETED release is
            // the worker's to convert, and an attached refund is in flight.
            (view.status.pendingAction === null ||
              view.status.releaseAwaitingSeller === true ||
              (view.status.pendingAction === "refund" &&
                !view.status.payloadAttached));
          const redeemable =
            !!signer &&
            view.status?.status === "refunded" &&
            !!view.status.payoutToken &&
            !redeemedIds.has(view.record.escrowId);
          // Early release: the buyer got their order and pays the seller out
          // of escrow before the lock expires.
          const releasable =
            !!signer &&
            view.status != null &&
            view.status.status === "locked" &&
            view.status.pendingAction === null &&
            view.status.expiresAt > nowSeconds;
          const busy = busyId === view.record.escrowId;
          return (
            <li
              key={view.record.escrowId}
              className="rounded-md border-2 border-black bg-white p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-bold text-black">
                    {view.record.amountSats.toLocaleString()} sats →{" "}
                    {shortNpub(view.record.sellerPubkey)}
                  </p>
                  <p className="text-xs text-gray-500">
                    Order {view.record.orderId.slice(0, 8)}… · locked until{" "}
                    {formatDate(view.record.expiresAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-bold ${chip.className}`}
                  >
                    {chip.label}
                  </span>
                  {redeemedIds.has(view.record.escrowId) && (
                    <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-bold text-green-800">
                      Redeemed to wallet
                    </span>
                  )}
                  {refundable && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleRefund(view)}
                      className="rounded-md border-2 border-black bg-yellow-300 px-3 py-1 text-xs font-bold text-black hover:bg-yellow-400 disabled:opacity-50"
                    >
                      {busy
                        ? "Requesting…"
                        : view.status?.pendingAction === "refund"
                          ? "Complete refund"
                          : "Request refund"}
                    </button>
                  )}
                  {releasable && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleRelease(view)}
                      className="rounded-md border-2 border-black bg-green-300 px-3 py-1 text-xs font-bold text-black hover:bg-green-400 disabled:opacity-50"
                    >
                      {busy ? "Releasing…" : "Release payment to seller"}
                    </button>
                  )}
                  {redeemable && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleRedeem(view)}
                      className="rounded-md border-2 border-black bg-blue-300 px-3 py-1 text-xs font-bold text-black hover:bg-blue-400 disabled:opacity-50"
                    >
                      {busy ? "Redeeming…" : "Redeem refund to wallet"}
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
