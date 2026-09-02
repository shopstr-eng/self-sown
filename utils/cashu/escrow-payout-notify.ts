// Post-finalize "your escrow payout arrived" notification.
//
// Payout delivery is pull-only (the payee polls the status endpoint from the
// orders page), so a payee who never opens the app never learns their escrow
// resolved. After the outbox entry is finalized, the payout worker sends the
// payee a gift-wrapped Nostr DM (signed by the server's ENCRYPTION_NSEC
// identity) delivered to the PAYEE's own NIP-65 read relays — the same
// seller-relay delivery pattern as order DMs.
//
// Custody rule (docs/cashu-escrow-threat-model.md): the message references
// the escrow id and the resolution ONLY — never the payout token. The
// P2PK-locked payout proofs stay behind the status endpoint, which the payee
// redeems from their orders page.
//
// Delivery is best-effort: a false return or a throw means the DM did not
// go out; the payout itself is already final and is NEVER retried or rolled
// back because of a notification failure.

import type {
  EscrowOutboxAction,
  EscrowRegistration,
} from "@/utils/db/cashu-escrow-service";
import { sendServerSideNostrDMToRecipientRelays } from "@/utils/nostr/server-nostr-helpers";

export async function notifyEscrowPayoutFinalized(
  registration: EscrowRegistration,
  action: EscrowOutboxAction
): Promise<boolean> {
  const isRelease = action === "release";
  // Release pays the seller; refund pays the buyer.
  const payeePubkey = isRelease
    ? registration.sellerPubkey
    : registration.buyerPubkey;
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://milk.market";
  const subject = isRelease
    ? "Escrow payout released"
    : "Escrow refund paid";
  const resolution = isRelease ? "released to you" : "refunded to you";
  const body = [
    `Your escrowed payment of ${registration.amountSats} sats for order ${registration.orderId} has been ${resolution}.`,
    `Open your orders page to redeem it: ${baseUrl}/orders`,
    `Escrow: ${registration.escrowId}`,
  ].join("\n");
  return sendServerSideNostrDMToRecipientRelays(payeePubkey, body, subject);
}
