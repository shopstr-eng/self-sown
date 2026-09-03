/**
 * @jest-environment jsdom
 *
 * Component coverage for the LAST MILE of escrow payouts: the in-app buttons
 * that move escrowed funds —
 *   BuyerEscrowList:  "Request refund" / "Complete refund",
 *                     "Release payment to seller", "Redeem refund to wallet"
 *   SellerEscrowCell: "Sign & release payout", "Redeem payout to wallet"
 * The action flows sign an escrow action event with the local signer, witness
 * (or hand over raw) locked proofs, and fire the requestEscrow* API call; the
 * redeem flows sign the delivered payout proofs' P2PK witnesses and swap them
 * at the mint via wallet.receive, then merge the fresh proofs into the local
 * wallet. A regression in signer wiring or token decoding would silently break
 * refunds/releases and only surface when a real user is stuck (API-level
 * delivery is covered by __tests__/api/cashu-escrow-status.test.ts).
 *
 * Real-library guardrail: token DECODING and P2PK SIGNING run against the
 * real @cashu/cashu-ts (getDecodedToken on a real fixture token,
 * signEscrowLockedProofs via the real signP2PKProofs with a real key), so an
 * upstream API rename or a signer-interface drift fails here. Only the mint
 * transport (Mint/Wallet classes) and the status fetch are mocked.
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type EventTemplate,
} from "nostr-tools";
import {
  getEncodedToken,
  hasP2PKSignedProof,
  MintOperationError,
  type Proof,
} from "@cashu/cashu-ts";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import {
  ESCROW_ACTION_KIND,
  buildEscrowActionContent,
} from "@/utils/cashu/escrow-commitment";
import {
  isSellerEscrowRedeemed,
  listBuyerEscrows,
  requestEscrowRefund,
  requestEscrowRelease,
  requestEscrowReleaseApproval,
  signEscrowProofsWithSigner,
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
    signEscrowProofsWithSigner: jest.fn(actual.signEscrowProofsWithSigner),
    // The HTTP seams: fully mocked, so the tests assert the component fired
    // the right endpoint with the right payload without a server.
    requestEscrowRefund: jest.fn(),
    requestEscrowReleaseApproval: jest.fn(),
    requestEscrowRelease: jest.fn(),
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

  // The signers REALLY sign action events (finalizeEvent with the real key)
  // so the requestEscrow* payload assertions can verify the event signature.
  const buyerSigner = {
    _getPrivKey: async () => buyerSecret,
    sign: jest.fn((template: EventTemplate) =>
      finalizeEvent(template, buyerSecret)
    ),
  };
  const sellerSigner = {
    _getPrivKey: async () => sellerSecret,
    sign: jest.fn((template: EventTemplate) =>
      finalizeEvent(template, sellerSecret)
    ),
  };

  const buyerPayoutToken = getEncodedToken({
    mint: MINT,
    unit: "sat",
    proofs: [buyerPayoutProof(buyerPk)],
  });
  const sellerPayoutToken = getEncodedToken({
    mint: MINT,
    unit: "sat",
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

  /** Matches the escrow action event template handed to signer.sign. */
  function actionTemplate(action: "refund" | "release", escrowId: string) {
    return expect.objectContaining({
      kind: ESCROW_ACTION_KIND,
      content: buildEscrowActionContent({ action, escrowId }),
      tags: [
        ["d", escrowId],
        ["action", action],
      ],
    });
  }

  describe("BuyerEscrowList — redeem refund to wallet", () => {
    const escrowId = `${buyerPk}:order-1`;

    function seedBuyerRecord(lockedToken = "cashuAlocked") {
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
            lockedToken,
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
        buyerSigner,
        MINT
      );
      expect(mockLoadMint).toHaveBeenCalledTimes(1);
      expect(mockReceive).toHaveBeenCalledTimes(1);
      const receiveArg = mockReceive.mock.calls[0]![0] as {
        mint: string;
        proofs: Proof[];
        unit?: string;
      };
      expect(receiveArg.mint).toBe(MINT);
      // Regression: cashu-ts receive() rejects a unit-less token object.
      expect(receiveArg.unit).toBe("sat");
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

  describe("BuyerEscrowList — request / complete refund", () => {
    const escrowId = `${buyerPk}:order-1`;

    function seedRefundRecord() {
      // The record's lockedToken must REALLY decode: signEscrowLockedProofs
      // is a call-through spy, so the component decodes + witnesses the
      // actual locked proofs. Buyer is the refund key on an expired lock.
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
            lockedToken: buyerPayoutToken,
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

    it("signs the refund action + locked proofs and fires requestEscrowRefund", async () => {
      seedRefundRecord();
      mockFetchEscrowStatus.mockResolvedValue(
        statusResponse({
          escrowId,
          status: "locked",
          expiresAt: 1_700_000_000, // expired → refundable
        })
      );

      renderBuyerList();
      fireEvent.click(
        await screen.findByRole("button", { name: "Request refund" })
      );

      await waitFor(() => expect(requestEscrowRefund).toHaveBeenCalledTimes(1));

      // The signer was handed the escrow action template (refund, this
      // escrow), and the signed event is a real, valid Nostr event.
      expect(buyerSigner.sign).toHaveBeenCalledWith(
        actionTemplate("refund", escrowId)
      );
      // The locked proofs were witnessed through the real signing seam.
      expect(signEscrowLockedProofs).toHaveBeenCalledWith(
        buyerPayoutToken,
        buyerSigner,
        MINT
      );
      const [actionEvent, payoutProofs] = (requestEscrowRefund as jest.Mock)
        .mock.calls[0]!;
      expect(verifyEvent(actionEvent)).toBe(true);
      expect(actionEvent.pubkey).toBe(buyerPk);
      expect(payoutProofs).toHaveLength(1);
      expect(hasP2PKSignedProof(buyerPk, payoutProofs[0]!)).toBe(true);
    });

    it("offers 'Complete refund' for a payload-less pending refund and fires the same request", async () => {
      seedRefundRecord();
      mockFetchEscrowStatus.mockResolvedValue(
        statusResponse({
          escrowId,
          status: "locked",
          expiresAt: 1_700_000_000,
          pendingAction: "refund",
          payloadAttached: false,
        })
      );

      renderBuyerList();
      fireEvent.click(
        await screen.findByRole("button", { name: "Complete refund" })
      );

      await waitFor(() => expect(requestEscrowRefund).toHaveBeenCalledTimes(1));
      expect(buyerSigner.sign).toHaveBeenCalledWith(
        actionTemplate("refund", escrowId)
      );
      const [, payoutProofs] = (requestEscrowRefund as jest.Mock).mock
        .calls[0]!;
      expect(hasP2PKSignedProof(buyerPk, payoutProofs[0]!)).toBe(true);
    });

    it("surfaces a request failure as an error banner and re-enables the button", async () => {
      seedRefundRecord();
      mockFetchEscrowStatus.mockResolvedValue(
        statusResponse({
          escrowId,
          status: "locked",
          expiresAt: 1_700_000_000,
        })
      );
      (requestEscrowRefund as jest.Mock).mockRejectedValueOnce(
        new Error("refund endpoint down")
      );

      renderBuyerList();
      fireEvent.click(
        await screen.findByRole("button", { name: "Request refund" })
      );

      // Loud failure — an error banner, not a hang or a silent dead-end.
      await screen.findByText("refund endpoint down");
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Request refund" })
        ).toBeEnabled()
      );
    });
  });

  describe("BuyerEscrowList — release payment to seller", () => {
    const escrowId = `${buyerPk}:order-1`;

    function seedReleaseRecord() {
      localStorage.setItem(
        "cashu_escrows",
        JSON.stringify([
          {
            escrowId,
            orderId: "order-1",
            sellerPubkey: "d".repeat(64),
            amountSats: 100,
            mintUrl: MINT,
            expiresAt: 1_900_000_000,
            createdAt: 1_600_000_000,
            lockedToken: buyerPayoutToken,
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

    it("signs the release action and fires requestEscrowReleaseApproval with the RAW locked proofs", async () => {
      seedReleaseRecord();
      mockFetchEscrowStatus.mockResolvedValue(
        statusResponse({
          escrowId,
          status: "locked",
          pendingAction: null,
          expiresAt: 1_900_000_000, // still locked → early release
        })
      );

      renderBuyerList();
      fireEvent.click(
        await screen.findByRole("button", { name: "Release payment to seller" })
      );

      await waitFor(() =>
        expect(requestEscrowReleaseApproval).toHaveBeenCalledTimes(1)
      );

      expect(buyerSigner.sign).toHaveBeenCalledWith(
        actionTemplate("release", escrowId)
      );
      const [actionEvent, proofs] = (requestEscrowReleaseApproval as jest.Mock)
        .mock.calls[0]!;
      expect(verifyEvent(actionEvent)).toBe(true);
      expect(actionEvent.pubkey).toBe(buyerPk);
      // Only the seller can witness pre-expiry, so the buyer hands over the
      // RAW proofs — no buyer witness may be attached at this stage.
      expect(proofs).toHaveLength(1);
      expect(proofs[0]!.witness).toBeUndefined();
      // No mint interaction: approval is a pure server call.
      expect(mockReceive).not.toHaveBeenCalled();
    });

    it("surfaces an approval failure as an error banner and re-enables the button", async () => {
      seedReleaseRecord();
      mockFetchEscrowStatus.mockResolvedValue(
        statusResponse({
          escrowId,
          status: "locked",
          pendingAction: null,
          expiresAt: 1_900_000_000,
        })
      );
      (requestEscrowReleaseApproval as jest.Mock).mockRejectedValueOnce(
        new Error("release-approve endpoint down")
      );

      renderBuyerList();
      fireEvent.click(
        await screen.findByRole("button", { name: "Release payment to seller" })
      );

      await screen.findByText("release-approve endpoint down");
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Release payment to seller" })
        ).toBeEnabled()
      );
    });
  });

  describe("SellerEscrowCell — sign & release payout", () => {
    const escrowId = `${buyerPk}:order-3`;

    function renderSellerCell() {
      return render(
        <SignerContext.Provider
          value={{ signer: sellerSigner, isLoggedIn: true } as never}
        >
          <SellerEscrowCell escrowId={escrowId} />
        </SignerContext.Provider>
      );
    }

    it("witnesses the releaseProofs, signs the release action, and fires requestEscrowRelease", async () => {
      const releaseProofs = [sellerPayoutProof(sellerPk)];
      mockFetchEscrowStatus.mockResolvedValue(
        statusResponse({
          escrowId,
          status: "locked",
          releaseAwaitingSeller: true,
          releaseProofs,
          mintUrl: MINT,
          expiresAt: 1_900_000_000, // pre-expiry: seller key is entitled
        })
      );

      renderSellerCell();
      fireEvent.click(
        await screen.findByRole("button", { name: "Sign & release payout" })
      );

      await waitFor(() =>
        expect(requestEscrowRelease).toHaveBeenCalledTimes(1)
      );

      // The served releaseProofs were witnessed with the seller's key through
      // the real signing seam, and the action event template is this escrow's
      // release.
      expect(signEscrowProofsWithSigner).toHaveBeenCalledWith(
        releaseProofs,
        sellerSigner
      );
      expect(sellerSigner.sign).toHaveBeenCalledWith(
        actionTemplate("release", escrowId)
      );
      const [actionEvent, payoutProofs] = (requestEscrowRelease as jest.Mock)
        .mock.calls[0]!;
      expect(verifyEvent(actionEvent)).toBe(true);
      expect(actionEvent.pubkey).toBe(sellerPk);
      expect(payoutProofs).toHaveLength(1);
      expect(hasP2PKSignedProof(sellerPk, payoutProofs[0]!)).toBe(true);
    });

    it("surfaces a release failure as an error and re-enables the button", async () => {
      mockFetchEscrowStatus.mockResolvedValue(
        statusResponse({
          escrowId,
          status: "locked",
          releaseAwaitingSeller: true,
          releaseProofs: [sellerPayoutProof(sellerPk)],
          mintUrl: MINT,
          expiresAt: 1_900_000_000,
        })
      );
      (requestEscrowRelease as jest.Mock).mockRejectedValueOnce(
        new Error("release endpoint down")
      );

      renderSellerCell();
      fireEvent.click(
        await screen.findByRole("button", { name: "Sign & release payout" })
      );

      await screen.findByText("release endpoint down");
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Sign & release payout" })
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
        sellerSigner,
        MINT
      );
      expect(mockLoadMint).toHaveBeenCalledTimes(1);
      expect(mockReceive).toHaveBeenCalledTimes(1);
      const receiveArg = mockReceive.mock.calls[0]![0] as {
        mint: string;
        proofs: Proof[];
        unit?: string;
      };
      expect(receiveArg.mint).toBe(MINT);
      // Regression: cashu-ts receive() rejects a unit-less token object.
      expect(receiveArg.unit).toBe("sat");
      expect(hasP2PKSignedProof(sellerPk, receiveArg.proofs[0]!)).toBe(true);

      expect(persistReceivedTokens).toHaveBeenCalledWith(FRESH_PROOFS, MINT);
      expect(storedTokenSecrets()).toContain("fresh-redeemed-proof-secret");
      expect(storedMints()[0]).toBe(MINT);

      // The persisted "redeemed" marker keeps the (now spent) payout from
      // being offered again after a reload.
      expect(isSellerEscrowRedeemed(escrowId)).toBe(true);
    });

    // Regression: a seller who already redeemed on another device/browser (or
    // cleared site data) has no localStorage marker, so the mint rejects the
    // re-redeem as already-spent. That means the money is already in their
    // wallet — the cell must converge on the stable redeemed state, not show
    // a raw mint error.
    it.each([
      [
        "structured NUT-00 code",
        new MintOperationError(11001, "Token already spent."),
      ],
      ["message only", new Error("tokens already spent")],
    ])(
      "treats an already-spent rejection (%s) as redeemed, not an error",
      async (_label, alreadySpentError) => {
        mockFetchEscrowStatus.mockResolvedValue(
          statusResponse({
            escrowId,
            status: "released",
            payoutToken: sellerPayoutToken,
            mintUrl: MINT,
          })
        );
        mockReceive.mockRejectedValue(alreadySpentError);

        renderSellerCell();
        const button = await screen.findByRole("button", {
          name: "Redeem payout to wallet",
        });
        fireEvent.click(button);

        await screen.findByText("Payout redeemed to wallet");

        // Nothing reached the wallet, but the marker converges so a reload
        // keeps showing the stable redeemed state.
        expect(persistReceivedTokens).not.toHaveBeenCalled();
        expect(storedTokenSecrets()).toHaveLength(0);
        expect(isSellerEscrowRedeemed(escrowId)).toBe(true);
      }
    );

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
