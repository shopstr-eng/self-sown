import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import userEvent from "@testing-library/user-event";
import SentTokens from "../sent-tokens";
import {
  NostrContext,
  SignerContext,
} from "@/components/utility-components/nostr-context-provider";
import { Wallet as CashuWallet, getDecodedToken } from "@cashu/cashu-ts";
import {
  filterUnspentProofs,
  persistReceivedTokens,
} from "@/utils/cashu/wallet-mint-sync";
import {
  getLocalStorageData,
  publishProofEvent,
} from "@/utils/nostr/nostr-helper-functions";
import {
  getOutgoingSendTokens,
  recordOutgoingSendToken,
} from "@/utils/cashu/outgoing-send-tokens";

jest.mock("@cashu/cashu-ts", () => ({
  ...jest.requireActual("@cashu/cashu-ts"),
  getDecodedToken: jest.fn(),
  Wallet: jest.fn(),
  Mint: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("@/utils/cashu/wallet-mint-sync", () => ({
  filterUnspentProofs: jest.fn(),
  persistReceivedTokens: jest.fn(),
}));
jest.mock("@/utils/nostr/nostr-helper-functions");

const mockGetDecodedToken = getDecodedToken as jest.Mock;
const MockCashuWallet = CashuWallet as jest.Mock;
const mockFilterUnspentProofs = filterUnspentProofs as jest.Mock;
const mockPersistReceivedTokens = persistReceivedTokens as jest.Mock;
const mockGetLocalStorageData = getLocalStorageData as jest.Mock;
const mockPublishProofEvent = publishProofEvent as jest.Mock;

const MINT = "https://mint.test";
const PROOFS = [
  { id: "k1", amount: 60, secret: "sec_a", C: "CA" },
  { id: "k1", amount: 40, secret: "sec_b", C: "CB" },
];
// Fresh secrets returned by the mint swap during reclaim.
const SWAPPED_PROOFS = [
  { id: "k1", amount: 64, secret: "sec_new_a", C: "CNA" },
  { id: "k1", amount: 36, secret: "sec_new_b", C: "CNB" },
];

const renderWithProviders = () =>
  render(
    <NostrContext.Provider value={{ nostr: {} } as any}>
      <SignerContext.Provider value={{ signer: {} } as any}>
        <SentTokens />
      </SignerContext.Provider>
    </NostrContext.Provider>
  );

describe("SentTokens", () => {
  let mockReceive: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockGetDecodedToken.mockReturnValue({ mint: MINT, proofs: PROOFS });
    mockGetLocalStorageData.mockReturnValue({ tokens: [], history: [] });
    mockPublishProofEvent.mockResolvedValue(undefined);
    mockReceive = jest.fn().mockResolvedValue(SWAPPED_PROOFS);
    MockCashuWallet.mockImplementation(() => ({
      loadMint: jest.fn().mockResolvedValue(undefined),
      receive: mockReceive,
    }));
    recordOutgoingSendToken({
      token: "cashuA_pending",
      mintUrl: MINT,
      amount: 100,
    });
  });

  test("renders nothing when there are no recorded tokens", () => {
    localStorage.clear();
    const { container } = renderWithProviders();
    expect(container).toBeEmptyDOMElement();
  });

  test("lists recorded tokens with amount and status", () => {
    renderWithProviders();
    expect(screen.getByText("Sent Tokens")).toBeVisible();
    expect(screen.getByText("100 sats")).toBeVisible();
    expect(screen.getByText(/Not yet checked/)).toBeVisible();
  });

  test("marks the token claimed when all proofs are spent", async () => {
    mockFilterUnspentProofs.mockResolvedValue({
      unspent: [],
      spentCount: 2,
      checked: true,
    });

    renderWithProviders();
    await userEvent.click(
      screen.getByRole("button", { name: /Check & Reclaim/i })
    );

    expect(
      await screen.findByText(/already redeemed by the recipient/i)
    ).toBeVisible();
    expect(screen.getByText(/Redeemed by recipient/)).toBeVisible();
    expect(getOutgoingSendTokens()[0]).toMatchObject({ status: "claimed" });
    expect(mockPersistReceivedTokens).not.toHaveBeenCalled();
  });

  test("reclaims by swapping proofs at the mint for fresh secrets", async () => {
    mockFilterUnspentProofs.mockResolvedValue({
      unspent: PROOFS,
      spentCount: 0,
      checked: true,
    });
    const setItemSpy = jest.spyOn(Storage.prototype, "setItem");

    renderWithProviders();
    await userEvent.click(
      screen.getByRole("button", { name: /Check & Reclaim/i })
    );

    expect(
      await screen.findByText(/Reclaimed 100 sats back into your wallet/i)
    ).toBeVisible();
    // The mint swap must be fed the original unspent proofs...
    expect(mockReceive).toHaveBeenCalledWith({ mint: MINT, proofs: PROOFS });
    // ...but only the FRESH swapped proofs may be credited to the wallet.
    expect(mockPersistReceivedTokens).toHaveBeenCalledWith(
      SWAPPED_PROOFS,
      MINT
    );
    expect(getOutgoingSendTokens()[0]).toMatchObject({ status: "reclaimed" });
    const historyCall = setItemSpy.mock.calls.find(
      (call) => call[0] === "history"
    );
    expect(historyCall).toBeDefined();
    expect(JSON.parse(historyCall![1])[0]).toMatchObject({
      type: 1,
      amount: 100,
    });
    await waitFor(() =>
      expect(mockPublishProofEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        MINT,
        SWAPPED_PROOFS,
        "in",
        "100"
      )
    );
    setItemSpy.mockRestore();
  });

  test("stays unclaimed and credits nothing when the mint swap fails", async () => {
    mockFilterUnspentProofs.mockResolvedValue({
      unspent: PROOFS,
      spentCount: 0,
      checked: true,
    });
    mockReceive.mockRejectedValue(new Error("swap failed"));

    renderWithProviders();
    await userEvent.click(
      screen.getByRole("button", { name: /Check & Reclaim/i })
    );

    expect(await screen.findByText(/Couldn't check that token/i)).toBeVisible();
    expect(getOutgoingSendTokens()[0]).toMatchObject({ status: "unclaimed" });
    expect(mockPersistReceivedTokens).not.toHaveBeenCalled();
  });

  test("leaves the token unclaimed when the mint is unreachable", async () => {
    mockFilterUnspentProofs.mockResolvedValue({
      unspent: PROOFS,
      spentCount: 0,
      checked: false,
    });

    renderWithProviders();
    await userEvent.click(
      screen.getByRole("button", { name: /Check & Reclaim/i })
    );

    expect(
      await screen.findByText(/mint is unreachable right now/i)
    ).toBeVisible();
    expect(getOutgoingSendTokens()[0]).toMatchObject({ status: "unclaimed" });
    expect(mockPersistReceivedTokens).not.toHaveBeenCalled();
  });

  test("skips proofs that are already back in the wallet", async () => {
    mockFilterUnspentProofs.mockResolvedValue({
      unspent: PROOFS,
      spentCount: 0,
      checked: true,
    });
    mockGetLocalStorageData.mockReturnValue({
      tokens: PROOFS,
      history: [],
    });

    renderWithProviders();
    await userEvent.click(
      screen.getByRole("button", { name: /Check & Reclaim/i })
    );

    expect(
      await screen.findByText(/already back in your wallet/i)
    ).toBeVisible();
    expect(getOutgoingSendTokens()[0]).toMatchObject({ status: "reclaimed" });
    expect(mockPersistReceivedTokens).not.toHaveBeenCalled();
  });
});
