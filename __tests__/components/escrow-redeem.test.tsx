/**
 * @jest-environment jsdom
 *
 * Component coverage for the LAST MILE of escrow payouts: the in-app redeem
 * buttons that turn a delivered P2PK-locked payout token into wallet funds —
 * BuyerEscrowList's "Redeem refund to wallet" and SellerEscrowCell's "Redeem
 * payout to wallet". Both flows sign the delivered payout proofs' P2PK
 * witnesses with the local signer and swap them at the mint via
 * wallet.receive, then merge the fresh proofs into the local wallet. A
 * regression in signer wiring or token decoding would strand payees with an
 * unredeemable payout and only surface in production (API-level delivery is
 * covered by __tests__/api/cashu-escrow-status.test.ts).
 *
 * Real-library guardrail: token DECODING and P2PK SIGNING run against the
 * real @cashu/cashu-ts (getDecodedToken on a real fixture token,
 * signEscrowLockedProofs via the real signP2PKProofs with a real key), so an
 * upstream API rename or a signer-interface drift fails here. Only the mint
 * transport (Mint/Wallet classes) and the status fetch are mocked.
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import {
  getEncodedToken,
  hasP2PKSignedProof,
  type Proof,
} from "@cashu/cashu-ts";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import {
  isSellerEscrowRedeemed,
  listBuyerEscrows,
} from "@/utils/cashu/escrow-checkout";
import { persistReceivedTokens } from "@/utils/cashu/wallet-mint-sync";
import BuyerEscrowList from "@/components/escrow/buyer-escrow-list";
import SellerEscrowCell from "@/components/escrow/seller-escrow-cell";

// ── Mint transport mock ──────────────────────────────────────────────────────
// The components construct `new CashuWallet(new CashuMint(url))` and call
// loadMint/receive on it. Stub ONLY those two classes; every other export
// (getDecodedToken, signP2PKProofs, hasP2PKSignedProof, …) stays real.
const mockLoadMint = jest.fn();
const mockReceive = jest.fn();
jest.mock("@cashu/cashu-ts", () => {
  const actual = jest.requireActual("@cashu/cashu-ts");
  class MockMint {
    constructor(public url: string) {}
  }
  class MockWallet {
    constructor(public mint: unknown) {}
    loadMint(...args: unknown[]) {
      return mockLoadMint(...args);
    }
    receive(...args: unknown[]) {
      return mockReceive(...args);
    }
  }
  return { ...actual, Mint: MockMint, Wallet: MockWallet };
});

// ── Status fetch mock (sign + everything else stays real) ────────────────────
// signEscrowLockedProofs is wrapped in a spy that CALLS THROUGH to the real
// implementation, so the test asserts the component actually invoked the
// signer wiring while still exercising the real P2PK witness signing.
const mockFetchEscrowStatus = jest.fn();
jest.mock("@/utils/cashu/escrow-checkout", () => {
  const actual = jest.requireActual("@/utils/cashu/escrow-checkout");
  return {
    ...actual,
    fetchEscrowStatus: (...args: unknown[]) => mockFetchEscrowStatus(...args),
    signEscrowLockedProofs: jest.fn(actual.signEscrowLockedProofs),
  };
});
import { signEscrowLockedProofs } from "@/utils/cashu/escrow-checkout";

// persistReceivedTokens is also a call-through spy: the real merge runs
// against jsdom localStorage, so the test can assert BOTH that the component
// invoked the persist seam and that the wallet contents actually changed.
jest.mock("@/utils/cashu/wallet-mint-sync", () => {
  const actual = jest.requireActual("@/utils/cashu/wallet-mint-sync");
  return {
    ...actual,
    persistReceivedTokens: jest.fn(actual.persistReceivedTokens),
  };
});

const MINT = "https://mint.example";
const FLAG = "NEXT_PUBLIC_CASHU_ESCROW_ENABLED";

// The proofs the mint's swap returns (what wallet.receive resolves with).
const FRESH_PROOFS = [
  {
    id: "009a1f293253e41e",
    amount: 100,
    secret: "fresh-redeemed-proof-secret",
    C: "02" + "ab".repeat(32),
  },
] as unknown as Proof[];

/**
 * Buyer refund payout: locked to the seller pre-expiry with the buyer as the
 * refund key on an already-expired locktime — so the buyer's key is the
 * entitled signer NOW (mirrors the checkout lock config).
 */
function buyerPayoutProof(buyerPk: string): Proof {
  return {
    id: "009a1f293253e41e",
    amount: 100,
    secret: JSON.stringify([
      "P2PK",
      {
        nonce: "ab".repeat(16),
        data: "d".repeat(64),
        tags: [
          ["locktime", "1700000000"], // expired: refund window
          ["refund", buyerPk],
          ["sigflag", "SIG_INPUTS"],
        ],
      },
    ]),
    C: "02" + "cd".repeat(32),
  } as unknown as Proof; // wire-format proof: plain-integer amount
}

/** Seller release payout: locked to the seller's key as the primary signer. */
function sellerPayoutProof(sellerPk: string): Proof {
  return {
    id: "009a1f293253e41e",
    amount: 100,
    secret: JSON.stringify([
      "P2PK",
      {
        nonce: "cd".repeat(16),
        data: sellerPk,
        tags: [["sigflag", "SIG_INPUTS"]],
      },
    ]),
    C: "02" + "ef".repeat(32),
  } as unknown as Proof;
}

function storedTokenSecrets(): string[] {
  return (JSON.parse(localStorage.getItem("tokens") || "[]") as Proof[]).map(
    (p) => p.secret
  );
}

function storedMints(): string[] {
  return JSON.parse(localStorage.getItem("mints") || "[]") as string[];
}

describe("escrow payout redemption", () => {
  const buyerSecret = generateSecretKey();
  const buyerPk = getPublicKey(buyerSecret);
  const sellerSecret = generateSecretKey();
  const sellerPk = getPublicKey(sellerSecret);

  const buyerSigner = {
    _getPrivKey: async () => buyerSecret,
    sign: jest.fn(),
  };
  const sellerSigner = {
    _getPrivKey: async () => sellerSecret,
    sign: jest.fn(),
  };

  const buyerPayoutToken = getEncodedToken({
    mint: MINT,
    proofs: [buyerPayoutProof(buyerPk)],
  });
  const sellerPayoutToken = getEncodedToken({
    mint: MINT,
    proofs: [sellerPayoutProof(sellerPk)],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    process.env[FLAG] = "true";
    mockLoadMint.mockResolvedValue(undefined);
    mockReceive.mockResolvedValue(FRESH_PROOFS);
  });

  afterEach(() => {
    delete process.env[FLAG];
  });

  function statusResponse(overrides: Record<string, unknown>) {
    return {
      escrowId: "escrow-1",
      status: "locked",
      expiresAt: 1_900_000_000,
      pendingAction: null,
      payloadAttached: false,
      ...overrides,
    };
  }

  describe("BuyerEscrowList — redeem refund to wallet", () => {
    const escrowId = `${buyerPk}:order-1`;

    function seedBuyerRecord() {
      localStorage.setItem(
        "cashu_escrows",
        JSON.stringify([
          {
            escrowId,
            orderId: "order-1",
            sellerPubkey: "d".repeat(64),
            amountSats: 100,
            mintUrl: MINT,
            expiresAt: 1_700_000_000,
            createdAt: 1_600_000_000,
            lockedToken: "cashuAlocked",
          },
        ])
      );
    }

    function renderBuyerList() {
      return render(
        <SignerContext.Provider
          value={
            {
              signer: buyerSigner,
              pubkey: buyerPk,
              isLoggedIn: true,
            } as never
          }
        >
          <BuyerEscrowList />
        </SignerContext.Provider>
      );
    }

    it("signs the payout proofs, swaps them at the mint, and persists the fresh proofs", async () => {
      seedBuyerRecord();
      mockFetchEscrowStatus.mockResolvedValue(
        statusResponse({
          escrowId,
          status: "refunded",
          payoutToken: buyerPayoutToken,
          mintUrl: MINT,
        })
      );

      renderBuyerList();
      const button = await screen.findByRole("button", {
        name: "Redeem refund to wallet",
      });
      fireEvent.click(button);

      // Terminal success state.
      await screen.findByText("Redeemed to wallet");

      // Sign: the component routed the RAW payout token through the real
      // signer wiring, and the proofs handed to the mint carry a valid buyer
      // P2PK witness (checked with the real library verifier).
      expect(signEscrowLockedProofs).toHaveBeenCalledWith(
        buyerPayoutToken,
        buyerSigner
      );
      expect(mockLoadMint).toHaveBeenCalledTimes(1);
      expect(mockReceive).toHaveBeenCalledTimes(1);
      const receiveArg = mockReceive.mock.calls[0]![0] as {
        mint: string;
        proofs: Proof[];
      };
      expect(receiveArg.mint).toBe(MINT);
      expect(receiveArg.proofs).toHaveLength(1);
      expect(hasP2PKSignedProof(buyerPk, receiveArg.proofs[0]!)).toBe(true);

      // Persist: the fresh proofs reached the wallet seam AND localStorage.
      expect(persistReceivedTokens).toHaveBeenCalledWith(FRESH_PROOFS, MINT);
      expect(storedTokenSecrets()).toContain("fresh-redeemed-proof-secret");
      expect(storedMints()[0]).toBe(MINT);

      // Terminal bookkeeping: the refunded+redeemed record is pruned so the
      // spent token is never offered again.
      expect(listBuyerEscrows()).toHaveLength(0);
    });

    it("surfaces a mint failure as an error and keeps the record", async () => {
      seedBuyerRecord();
      mockFetchEscrowStatus.mockResolvedValue(
        statusResponse({
          escrowId,
          status: "refunded",
          payoutToken: buyerPayoutToken,
          mintUrl: MINT,
        })
      );
      mockReceive.mockRejectedValue(new Error("mint exploded"));

      renderBuyerList();
      const button = await screen.findByRole("button", {
        name: "Redeem refund to wallet",
      });
      fireEvent.click(button);

      // The failure is loud — an error banner, not a silent dead-end.
      await screen.findByText("mint exploded");
      expect(screen.queryByText("Redeemed to wallet")).not.toBeInTheDocument();

      // Nothing was persisted or pruned: the payout stays redeemable.
      expect(persistReceivedTokens).not.toHaveBeenCalled();
      expect(storedTokenSecrets()).toHaveLength(0);
      expect(listBuyerEscrows()).toHaveLength(1);

      // The button is re-enabled (busy cleared in finally) for a retry.
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Redeem refund to wallet" })
        ).toBeEnabled()
      );
    });
  });

  describe("SellerEscrowCell — redeem payout to wallet", () => {
    const escrowId = `${buyerPk}:order-2`;

    function renderSellerCell() {
      return render(
        <SignerContext.Provider
          value={{ signer: sellerSigner, isLoggedIn: true } as never}
        >
          <SellerEscrowCell escrowId={escrowId} />
        </SignerContext.Provider>
      );
    }

    it("signs the payout proofs, swaps them at the mint, and persists the fresh proofs", async () => {
      mockFetchEscrowStatus.mockResolvedValue(
        statusResponse({
          escrowId,
          status: "released",
          payoutToken: sellerPayoutToken,
          mintUrl: MINT,
        })
      );

      renderSellerCell();
      const button = await screen.findByRole("button", {
        name: "Redeem payout to wallet",
      });
      fireEvent.click(button);

      await screen.findByText("Payout redeemed to wallet");

      expect(signEscrowLockedProofs).toHaveBeenCalledWith(
        sellerPayoutToken,
        sellerSigner
      );
      expect(mockLoadMint).toHaveBeenCalledTimes(1);
      expect(mockReceive).toHaveBeenCalledTimes(1);
      const receiveArg = mockReceive.mock.calls[0]![0] as {
        mint: string;
        proofs: Proof[];
      };
      expect(receiveArg.mint).toBe(MINT);
      expect(hasP2PKSignedProof(sellerPk, receiveArg.proofs[0]!)).toBe(true);

      expect(persistReceivedTokens).toHaveBeenCalledWith(FRESH_PROOFS, MINT);
      expect(storedTokenSecrets()).toContain("fresh-redeemed-proof-secret");
      expect(storedMints()[0]).toBe(MINT);

      // The persisted "redeemed" marker keeps the (now spent) payout from
      // being offered again after a reload.
      expect(isSellerEscrowRedeemed(escrowId)).toBe(true);
    });

    it("surfaces a mint failure as an error and never writes the redeemed marker", async () => {
      mockFetchEscrowStatus.mockResolvedValue(
        statusResponse({
          escrowId,
          status: "released",
          payoutToken: sellerPayoutToken,
          mintUrl: MINT,
        })
      );
      mockReceive.mockRejectedValue(new Error("mint exploded"));

      renderSellerCell();
      const button = await screen.findByRole("button", {
        name: "Redeem payout to wallet",
      });
      fireEvent.click(button);

      await screen.findByText("mint exploded");
      expect(
        screen.queryByText("Payout redeemed to wallet")
      ).not.toBeInTheDocument();

      // No wallet write, no marker — a reload may re-offer the redeem.
      expect(persistReceivedTokens).not.toHaveBeenCalled();
      expect(storedTokenSecrets()).toHaveLength(0);
      expect(isSellerEscrowRedeemed(escrowId)).toBe(false);

      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Redeem payout to wallet" })
        ).toBeEnabled()
      );
    });
  });
});
