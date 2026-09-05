/**
 * @jest-environment jsdom
 *
 * Server-side rediscovery coverage for BuyerEscrowList: a buyer who wiped
 * their browser AFTER a refund payout executed has no local escrow record,
 * and the kind-7375 restore correctly refuses to resurrect the SPENT locked
 * proofs. The list must rediscover the escrow via the authenticated
 * /api/cashu/escrow/mine endpoint and offer "Redeem refund to wallet" —
 * redeem needs only the escrowId (the bearer status endpoint serves the
 * buyer-P2PK-locked payout token). Still-locked escrows must NOT be
 * rediscovered this way: their lockedToken died with the browser and the
 * server never holds it, so the kind-7375 backup restore owns those.
 *
 * Only the two fetch seams are mocked; localStorage record handling is real.
 */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import BuyerEscrowList from "@/components/escrow/buyer-escrow-list";
import { recordBuyerEscrow } from "@/utils/cashu/escrow-checkout";

const mockFetchEscrowStatus = jest.fn();
const mockFetchMyEscrows = jest.fn();
jest.mock("@/utils/cashu/escrow-checkout", () => {
  const actual = jest.requireActual("@/utils/cashu/escrow-checkout");
  return {
    ...actual,
    fetchEscrowStatus: (...args: unknown[]) => mockFetchEscrowStatus(...args),
    fetchMyEscrows: (...args: unknown[]) => mockFetchMyEscrows(...args),
  };
});

const BUYER_PK = "b".repeat(64);
const SELLER_PK = "d".repeat(64);
const MINT = "https://mint.example";
const ESCROW_ID = `${BUYER_PK}:order-wiped`;
const FLAG = "NEXT_PUBLIC_CASHU_ESCROW_ENABLED";

function serverSummary(overrides: Record<string, unknown> = {}) {
  return {
    escrowId: ESCROW_ID,
    orderId: "order-wiped",
    sellerPubkey: SELLER_PK,
    amountSats: 1234,
    mintUrl: MINT,
    expiresAt: 1_900_000_000,
    createdAt: 1_800_000_000,
    status: "refunded",
    pendingAction: null,
    payoutAvailable: true,
    ...overrides,
  };
}

function refundedStatus(escrowId: string) {
  return {
    escrowId,
    status: "refunded",
    expiresAt: 1_900_000_000,
    pendingAction: null,
    payloadAttached: true,
    payoutToken: "cashuBpayouttoken",
    mintUrl: MINT,
  };
}

function seedLocalRecord() {
  recordBuyerEscrow({
    escrowId: ESCROW_ID,
    orderId: "order-wiped",
    sellerPubkey: SELLER_PK,
    amountSats: 1234,
    mintUrl: MINT,
    expiresAt: 1_900_000_000,
    createdAt: 1_800_000_000,
    lockedToken: "cashuAlocked",
  });
}

function renderList() {
  return render(
    <SignerContext.Provider
      value={
        {
          signer: { getPubKey: async () => BUYER_PK },
          pubkey: BUYER_PK,
          isLoggedIn: true,
        } as never
      }
    >
      <BuyerEscrowList />
    </SignerContext.Provider>
  );
}

describe("BuyerEscrowList server-side rediscovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    process.env[FLAG] = "true";
    mockFetchMyEscrows.mockResolvedValue([]);
    mockFetchEscrowStatus.mockResolvedValue(null);
  });
  afterEach(() => {
    delete process.env[FLAG];
  });

  it("rediscovers a wiped browser's completed refund payout and offers redeem", async () => {
    mockFetchMyEscrows.mockResolvedValue([serverSummary()]);
    mockFetchEscrowStatus.mockResolvedValue(refundedStatus(ESCROW_ID));

    renderList();

    // The card comes back from the server alone — no local record existed.
    await screen.findByRole("button", { name: "Redeem refund to wallet" });
    expect(mockFetchMyEscrows).toHaveBeenCalledTimes(1);
    expect(mockFetchEscrowStatus).toHaveBeenCalledWith(ESCROW_ID);
    expect(screen.getByText(/Order order-wi/)).toBeInTheDocument();
    // The synthesized record is component-state only: never persisted with
    // its empty lockedToken (which would break backup republish + refund).
    expect(localStorage.getItem("cashu_escrows")).toBeNull();
  });

  it("does not duplicate an escrow the browser already holds locally", async () => {
    seedLocalRecord();
    mockFetchMyEscrows.mockResolvedValue([serverSummary()]);
    mockFetchEscrowStatus.mockResolvedValue(refundedStatus(ESCROW_ID));

    renderList();

    await screen.findByRole("button", { name: "Redeem refund to wallet" });
    expect(
      screen.getAllByRole("button", { name: "Redeem refund to wallet" })
    ).toHaveLength(1);
    // The local record — and its lockedToken — is untouched: the
    // rediscovered summary must never shadow or rewrite the real record
    // (refund/release still need the token).
    const stored = JSON.parse(localStorage.getItem("cashu_escrows") ?? "[]");
    expect(
      stored.find((r: { escrowId: string }) => r.escrowId === ESCROW_ID)
        ?.lockedToken
    ).toBe("cashuAlocked");
  });

  it("does NOT rediscover still-locked escrows (kind-7375 restore owns those)", async () => {
    mockFetchMyEscrows.mockResolvedValue([
      serverSummary({ status: "locked", payoutAvailable: false }),
    ]);

    const { container } = renderList();

    await waitFor(() => expect(mockFetchMyEscrows).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByText(/Order order-wi/)).not.toBeInTheDocument()
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the local view when rediscovery fails (best-effort, never fatal)", async () => {
    seedLocalRecord();
    mockFetchMyEscrows.mockRejectedValue(
      new Error("Escrow rediscovery lookup failed.")
    );
    mockFetchEscrowStatus.mockResolvedValue(refundedStatus(ESCROW_ID));

    renderList();

    await screen.findByRole("button", { name: "Redeem refund to wallet" });
    expect(mockFetchMyEscrows).toHaveBeenCalledTimes(1);
  });
});
