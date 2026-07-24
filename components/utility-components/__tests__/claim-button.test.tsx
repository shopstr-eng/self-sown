import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import userEvent from "@testing-library/user-event";
import { nip19 } from "nostr-tools";
import ClaimButton from "../claim-button";
import {
  NostrContext,
  SignerContext,
} from "@/components/utility-components/nostr-context-provider";
import { ProfileMapContext, ChatsContext } from "@/utils/context/context";
import { getDecodedToken, getEncodedToken } from "@cashu/cashu-ts";
import { safeSwap } from "@/utils/cashu/swap-retry-service";
import { safeMeltProofs } from "@/utils/cashu/melt-retry-service";
import { stashProofsLocally } from "@/utils/cashu/local-wallet-stash";
import {
  generateKeys,
  getLocalStorageData,
  sendGiftWrappedMessageEvent,
  constructGiftWrappedEvent,
  constructMessageSeal,
  constructMessageGiftWrap,
} from "@/utils/nostr/nostr-helper-functions";
import { LightningAddress } from "@getalby/lightning-tools";

jest.setTimeout(20000);

jest.mock("@cashu/cashu-ts", () => ({
  ...jest.requireActual("@cashu/cashu-ts"),
  Wallet: jest.fn(),
  Mint: jest.fn().mockImplementation(() => ({})),
  getDecodedToken: jest.fn(),
  getEncodedToken: jest.fn(),
}));
jest.mock("@getalby/lightning-tools", () => ({
  LightningAddress: jest.fn(),
}));
jest.mock("@/utils/cashu/swap-retry-service", () => ({
  safeSwap: jest.fn(),
}));
jest.mock("@/utils/cashu/melt-retry-service", () => ({
  safeMeltProofs: jest.fn(),
}));
jest.mock("@/utils/cashu/local-wallet-stash", () => ({
  stashProofsLocally: jest.fn(),
}));
jest.mock("@/utils/cashu/wallet-mint-sync", () => ({
  persistReceivedTokens: jest.fn(),
}));
jest.mock("@/utils/nostr/nostr-helper-functions");

jest.mock("@heroicons/react/24/outline", () => ({
  ArrowDownTrayIcon: () => <div data-testid="arrow-down-icon" />,
  BoltIcon: () => <div data-testid="bolt-icon" />,
  CheckCircleIcon: () => <div data-testid="check-circle-icon" />,
  XCircleIcon: () => <div data-testid="x-circle-icon" />,
}));

const { Wallet: MockCashuWallet } = jest.requireMock("@cashu/cashu-ts");
const MockLightningAddress = LightningAddress as jest.Mock;
const mockGetDecodedToken = getDecodedToken as jest.Mock;
const mockGetEncodedToken = getEncodedToken as jest.Mock;
const mockSafeSwap = safeSwap as jest.Mock;
const mockSafeMeltProofs = safeMeltProofs as jest.Mock;
const mockStashProofsLocally = stashProofsLocally as jest.Mock;
const mockGenerateKeys = generateKeys as jest.Mock;
const mockGetLocalStorageData = getLocalStorageData as jest.Mock;
const mockSendGiftWrappedMessageEvent =
  sendGiftWrappedMessageEvent as jest.Mock;
const mockConstructGiftWrappedEvent = constructGiftWrappedEvent as jest.Mock;
const mockConstructMessageSeal = constructMessageSeal as jest.Mock;
const mockConstructMessageGiftWrap = constructMessageGiftWrap as jest.Mock;

const MINT = "https://mint.test";
const USER_PUBKEY = "ab".repeat(32);
const amt = (n: number) => ({ toNumber: () => n });
const TOKEN_PROOFS = [
  { id: "k1", amount: amt(60), secret: "tok_a", C: "TA" },
  { id: "k1", amount: amt(40), secret: "tok_b", C: "TB" },
];
const KEEP = [{ id: "k1", amount: amt(4), secret: "keep_s", C: "CK" }];
const SEND = [{ id: "k1", amount: amt(92), secret: "send_s", C: "CS" }];
const MELT_CHANGE = [{ id: "k1", amount: amt(2), secret: "chg_s", C: "CC" }];

const NPUB = nip19.npubEncode("cd".repeat(32));
const NSEC = nip19.nsecEncode(new Uint8Array(32).fill(7));

const renderClaim = () =>
  render(
    <NostrContext.Provider value={{ nostr: {} } as any}>
      <SignerContext.Provider
        value={{ signer: {} as any, pubkey: USER_PUBKEY } as any}
      >
        <ProfileMapContext.Provider
          value={
            {
              profileData: new Map([
                [USER_PUBKEY, { content: { lud16: "user@ln.test" } }],
              ]),
            } as any
          }
        >
          <ChatsContext.Provider
            value={{ addNewlyCreatedMessageEvent: jest.fn() } as any}
          >
            <ClaimButton token="cashuA_claim_test" />
          </ChatsContext.Provider>
        </ProfileMapContext.Provider>
      </SignerContext.Provider>
    </NostrContext.Provider>
  );

const clickThroughToRedeem = async () => {
  await userEvent.click(await screen.findByRole("button", { name: /Claim:/i }));
  await userEvent.click(await screen.findByRole("button", { name: /Redeem/i }));
};

describe("ClaimButton redeem recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockGetDecodedToken.mockReturnValue({ mint: MINT, proofs: TOKEN_PROOFS });
    mockGetEncodedToken.mockReturnValue("cashuA_change");
    mockGetLocalStorageData.mockReturnValue({
      mints: [MINT],
      tokens: [],
      history: [],
    });
    mockGenerateKeys.mockResolvedValue({ npub: NPUB, nsec: NSEC });
    MockCashuWallet.mockImplementation(() => ({
      loadMint: jest.fn().mockResolvedValue(undefined),
      checkProofsStates: jest
        .fn()
        .mockResolvedValue(
          TOKEN_PROOFS.map((_, i) => ({ state: "UNSPENT", Y: `y${i}` }))
        ),
      createMeltQuoteBolt11: jest.fn().mockResolvedValue({
        amount: amt(90),
        fee_reserve: amt(2),
      }),
    }));
    MockLightningAddress.mockImplementation(() => ({
      fetch: jest.fn().mockResolvedValue(undefined),
      requestInvoice: jest
        .fn()
        .mockResolvedValue({ paymentRequest: "lnbc_test" }),
    }));
    mockSafeSwap.mockResolvedValue({
      status: "swapped",
      keep: KEEP,
      send: SEND,
    });
    mockConstructGiftWrappedEvent.mockResolvedValue({ id: "gw" });
    mockConstructMessageSeal.mockResolvedValue({ id: "seal" });
    mockConstructMessageGiftWrap.mockResolvedValue({ id: "wrap" });
    mockSendGiftWrappedMessageEvent.mockResolvedValue(undefined);
  });

  test("stashes keep+send when the melt is rejected (unpaid)", async () => {
    mockSafeMeltProofs.mockResolvedValue({
      status: "unpaid",
      errorMessage: "no route",
    });

    renderClaim();
    await clickThroughToRedeem();

    await waitFor(() =>
      expect(mockStashProofsLocally).toHaveBeenCalledWith(
        [...KEEP, ...SEND],
        MINT,
        { note: "Recovered from failed token claim" }
      )
    );
  });

  test("stashes only keep when the melt outcome is ambiguous (pending)", async () => {
    mockSafeMeltProofs.mockResolvedValue({ status: "pending" });

    renderClaim();
    await clickThroughToRedeem();

    await waitFor(() =>
      expect(mockStashProofsLocally).toHaveBeenCalledWith(KEEP, MINT, {
        note: "Recovered from failed token claim",
      })
    );
  });

  test("stashes keep+change when the change message fails after a paid melt", async () => {
    mockSafeMeltProofs.mockResolvedValue({
      status: "paid",
      changeProofs: MELT_CHANGE,
    });
    mockSendGiftWrappedMessageEvent.mockRejectedValue(
      new Error("relay publish failed")
    );

    renderClaim();
    await clickThroughToRedeem();

    await waitFor(() =>
      expect(mockStashProofsLocally).toHaveBeenCalledWith(
        [...KEEP, ...MELT_CHANGE],
        MINT,
        { note: "Recovered from failed token claim" }
      )
    );
  });

  test("does not stash when the swap itself fails (token still unspent)", async () => {
    mockSafeSwap.mockResolvedValue({
      status: "insufficient",
      errorMessage: "not enough",
    });

    renderClaim();
    await clickThroughToRedeem();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Claim:/i })).toBeVisible()
    );
    expect(mockStashProofsLocally).not.toHaveBeenCalled();
    expect(mockSafeMeltProofs).not.toHaveBeenCalled();
  });
});
