// Seller-facing escrow payout cell, rendered in the orders dashboard payment
// column for escrow payments (payment tag "escrow", reference = escrow id).
//
// Polls the public status endpoint (knowing the escrow id is proof of
// involvement) and drives the seller half of the release flow: once the
// buyer approves an early release, the raw locked proofs are served at stage
// "awaiting_seller_witness"; the seller witnesses them with their own key
// (the lock's primary signer before expiry) and submits the release. When
// the payout worker completes, the seller-locked payout token can be
// redeemed into the local wallet.

import { useCallback, useContext, useEffect, useState } from "react";
import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  getDecodedToken,
} from "@cashu/cashu-ts";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { isEscrowClientEnabled } from "@/utils/cashu/escrow-config";
import { buildEscrowActionEventTemplate } from "@/utils/cashu/escrow-commitment";
import {
  EscrowStatusResponse,
  fetchEscrowStatus,
  requestEscrowRelease,
  signEscrowLockedProofs,
  signEscrowProofsWithSigner,
} from "@/utils/cashu/escrow-checkout";
import { persistReceivedTokens } from "@/utils/cashu/wallet-mint-sync";

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function SellerEscrowCell({ escrowId }: { escrowId: string }) {
  const { signer } = useContext(SignerContext);
  const [status, setStatus] = useState<EscrowStatusResponse | null | undefined>(
    undefined
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redeemed, setRedeemed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchEscrowStatus(escrowId));
    } catch {
      setStatus(null);
    }
  }, [escrowId]);

  useEffect(() => {
    if (!isEscrowClientEnabled()) return;
    void refresh();
  }, [refresh]);

  if (!isEscrowClientEnabled()) {
    return <span className="text-black">Escrow</span>;
  }

  const handleRelease = async () => {
    if (!signer || !status?.releaseProofs) return;
    setError(null);
    setBusy(true);
    try {
      // Witness the buyer-approved locked proofs with the seller key (the
      // lock's primary signer pre-expiry), then submit the signed release —
      // the endpoint validates and attaches atomically.
      const payoutProofs = await signEscrowProofsWithSigner(
        status.releaseProofs,
        signer
      );
      const actionEvent = await signer.sign(
        buildEscrowActionEventTemplate({ action: "release", escrowId })
      );
      await requestEscrowRelease(actionEvent, payoutProofs);
      await refresh();
    } catch (releaseError) {
      setError(
        releaseError instanceof Error
          ? releaseError.message
          : "Completing the release failed."
      );
    } finally {
      setBusy(false);
    }
  };

  const handleRedeem = async () => {
    if (!signer || !status?.payoutToken) return;
    setError(null);
    setBusy(true);
    try {
      // The payout proofs are P2PK-locked to the seller: sign the witness,
      // swap them at the mint into ordinary proofs, merge into the wallet.
      const signedProofs = await signEscrowLockedProofs(
        status.payoutToken,
        signer
      );
      const decoded = getDecodedToken(status.payoutToken, []);
      const wallet = new CashuWallet(new CashuMint(decoded.mint));
      await wallet.loadMint();
      const freshProofs = await wallet.receive({
        mint: decoded.mint,
        proofs: signedProofs,
      });
      persistReceivedTokens(freshProofs, decoded.mint);
      setRedeemed(true);
    } catch (redeemError) {
      setError(
        redeemError instanceof Error
          ? redeemError.message
          : "Redeeming the payout failed."
      );
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (status === undefined) {
    body = <span className="text-gray-600">Checking escrow…</span>;
  } else if (status === null) {
    body = <span className="text-gray-600">Escrow status unavailable</span>;
  } else if (status.status === "released") {
    body =
      status.payoutToken && !redeemed ? (
        <button
          type="button"
          disabled={busy || !signer}
          onClick={() => void handleRedeem()}
          className="rounded-md border-2 border-black bg-green-300 px-3 py-1 text-xs font-bold text-black hover:bg-green-400 disabled:opacity-50"
        >
          {busy ? "Redeeming…" : "Redeem payout to wallet"}
        </button>
      ) : (
        <span className="font-bold text-green-600">
          {redeemed ? "Payout redeemed to wallet" : "Escrow released to you"}
        </span>
      );
  } else if (status.status === "refunded") {
    body = <span className="text-gray-600">Refunded to buyer</span>;
  } else if (
    status.releaseAwaitingSeller &&
    status.expiresAt > Math.floor(Date.now() / 1000)
  ) {
    body = (
      <button
        type="button"
        disabled={busy || !signer}
        onClick={() => void handleRelease()}
        className="rounded-md border-2 border-black bg-green-300 px-3 py-1 text-xs font-bold text-black hover:bg-green-400 disabled:opacity-50"
      >
        {busy ? "Signing…" : "Sign & release payout"}
      </button>
    );
  } else if (status.releaseAwaitingSeller) {
    // The lock expired before the seller witnessed — the buyer owns the
    // funds now; the sweep/refund endpoint converts this to a refund.
    body = (
      <span className="text-gray-600">Escrow expired — buyer may refund</span>
    );
  } else if (status.pendingAction === "release") {
    body = <span className="text-gray-600">Release processing…</span>;
  } else if (status.pendingAction === "refund") {
    body = <span className="text-gray-600">Refund to buyer processing…</span>;
  } else {
    body = (
      <span className="text-black">
        Escrowed until {formatDate(status.expiresAt)}
        <span className="block max-w-[16rem] text-xs text-gray-600">
          Releases on buyer approval; refundable to the buyer after that date
        </span>
      </span>
    );
  }

  return (
    <div>
      {body}
      {error && (
        <span className="block max-w-[16rem] text-xs font-medium text-red-600">
          {error}
        </span>
      )}
    </div>
  );
}
