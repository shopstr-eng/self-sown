// Escrow payout notification: the payee gets a gift-wrapped DM referencing
// the escrow id and the resolution — never the payout token (custody rule),
// and the message is delivered to the payee's own relays via
// sendServerSideNostrDMToRecipientRelays.

import { notifyEscrowPayoutFinalized } from "@/utils/cashu/escrow-payout-notify";
import { sendServerSideNostrDMToRecipientRelays } from "@/utils/nostr/server-nostr-helpers";
import type { EscrowRegistration } from "@/utils/db/cashu-escrow-service";

jest.mock("@/utils/nostr/server-nostr-helpers", () => ({
  sendServerSideNostrDMToRecipientRelays: jest.fn(),
}));

const mockedSend = sendServerSideNostrDMToRecipientRelays as jest.Mock;

const REGISTRATION: EscrowRegistration = {
  escrowId: "buyer:order-1",
  buyerPubkey: "a".repeat(64),
  sellerPubkey: "b".repeat(64),
  orderId: "order-1",
  amountSats: 5_000,
  mintUrl: "https://mint.example",
  arbiterPubkey: null,
  expiresAt: new Date(Date.now() + 86_400_000),
  status: "locked",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedSend.mockResolvedValue(true);
});

describe("notifyEscrowPayoutFinalized", () => {
  it("notifies the SELLER on a release, referencing the escrow id and resolution", async () => {
    const result = await notifyEscrowPayoutFinalized(REGISTRATION, "release");

    expect(result).toBe(true);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const [pubkey, body, subject] = mockedSend.mock.calls[0]!;
    expect(pubkey).toBe(REGISTRATION.sellerPubkey);
    expect(subject).toMatch(/released/i);
    expect(body).toContain(REGISTRATION.escrowId);
    expect(body).toContain(REGISTRATION.orderId);
    expect(body).toContain("5000");
    expect(body).toMatch(/released/i);
    expect(body).toContain("/orders");
  });

  it("notifies the BUYER on a refund, referencing the escrow id and resolution", async () => {
    await notifyEscrowPayoutFinalized(REGISTRATION, "refund");

    const [pubkey, body, subject] = mockedSend.mock.calls[0]!;
    expect(pubkey).toBe(REGISTRATION.buyerPubkey);
    expect(subject).toMatch(/refund/i);
    expect(body).toContain(REGISTRATION.escrowId);
    expect(body).toMatch(/refunded/i);
  });

  it("never includes a payout token — the message carries the escrow id only", async () => {
    await notifyEscrowPayoutFinalized(REGISTRATION, "release");

    const [, body] = mockedSend.mock.calls[0]!;
    // Custody rule: tokens are pulled from the status endpoint, never pushed.
    expect(body).not.toMatch(/cashu[AB]/i); // serialized cashu token prefix
    expect(body).not.toMatch(/token/i);
    expect(body).not.toContain(REGISTRATION.mintUrl);
  });

  it("propagates a best-effort delivery failure as false", async () => {
    mockedSend.mockResolvedValue(false);

    const result = await notifyEscrowPayoutFinalized(REGISTRATION, "release");

    expect(result).toBe(false);
  });
});
