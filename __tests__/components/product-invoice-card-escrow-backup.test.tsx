/**
 * @jest-environment jsdom
 *
 * Component coverage for the escrow backup warning on ProductInvoiceCard.
 *
 * When a buyer pays via escrow, the card backs the locked proofs up to the
 * buyer's kind-7375 wallet events (publishEscrowBackup). A backup that can
 * never publish (e.g. a remote signer without NIP-44) leaves a lost browser
 * unrecoverable, so the card must surface describeEscrowBackupWarning's text
 * in the payment panel. Unit tests cover escrow-backup.ts; this test pins the
 * WIRING: a { published: false, failure: "encryption_failed" } result renders
 * the warning banner, and { published: true } renders none — so a refactor
 * that drops the result check fails here.
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
} from "nostr-tools";
import type { EventTemplate } from "nostr-tools";

// ── FX helpers: fixed rate so the sats button label resolves ────────────────
jest.mock("@/utils/stripe/currency", () => {
  const actual = jest.requireActual("@/utils/stripe/currency");
  return {
    ...actual,
    getSatoshiValueResilient: jest.fn(async () => 5000),
    getFiatValueResilient: jest.fn(async () => 10),
    // Non-resilient converter used by onFormSubmit for the USD listing —
    // without it the price stays NaN and the seller/escrow block is skipped.
    getSatoshiValue: jest.fn(async () => 5000),
  };
});

// ── Escrow backup seam: controlled result, REAL warning text ────────────────
// NOTE: the card imports BOTH publishEscrowBackup and
// registerEscrowCommitmentWithServer from escrow-backup — mocking the latter
// out of escrow-checkout would silently skip the record+backup branch.
const publishEscrowBackupMock = jest.fn();
jest.mock("@/utils/cashu/escrow-backup", () => {
  const actual = jest.requireActual("@/utils/cashu/escrow-backup");
  return {
    ...actual,
    publishEscrowBackup: (...args: unknown[]) =>
      publishEscrowBackupMock(...args),
  };
});

// ── Mint-side swap: return a fixture locked output without a mint ────────────
const LOCKED_PROOF = {
  id: "009a1f293253e41e",
  amount: 5000,
  secret: "locked-escrow-proof-secret",
  C: "02" + "ab".repeat(32),
};
const safeSwapMock = jest.fn(async () => ({
  status: "swapped",
  keep: [],
  send: [LOCKED_PROOF],
}));
jest.mock("@/utils/cashu/swap-retry-service", () => {
  const actual = jest.requireActual("@/utils/cashu/swap-retry-service");
  return {
    ...actual,
    // Closure (not direct reference): the factory runs before the const
    // initializers, so evaluation must be deferred to call time.
    safeSwap: () => safeSwapMock(),
  };
});

// ── Escrow checkout seams: gate stays REAL; registration is the only stub ───
// NOTE: the card imports registerEscrowCommitmentWithServer from
// escrow-checkout (and publishEscrowBackup from escrow-backup) — mocking the
// wrong module silently lets the real server call through.
const registerCommitmentMock = jest.fn(async () => ({
  escrowId: "escrow-test-1",
}));
jest.mock("@/utils/cashu/escrow-checkout", () => {
  const actual = jest.requireActual("@/utils/cashu/escrow-checkout");
  return {
    ...actual,
    // Closure (not direct reference): the factory runs before the const
    // initializers, so evaluation must be deferred to call time.
    registerEscrowCommitmentWithServer: () => registerCommitmentMock(),
  };
});

// ── Mint transport: stub only the classes, keep the rest of cashu-ts real ───
const mockLoadMint = jest.fn(async () => undefined);
const mockMintProofs = jest.fn(async () => [
  {
    id: "009a1f293253e41e",
    amount: 8192,
    secret: "funded-proof",
    C: "02" + "cd".repeat(32),
  },
]);
jest.mock("@cashu/cashu-ts", () => {
  const actual = jest.requireActual("@cashu/cashu-ts");
  class MockMint {
    constructor(public url: string) {}
  }
  class MockWallet {
    constructor(public mint: unknown) {}
    loadMint() {
      return mockLoadMint();
    }
    mintProofsBolt11() {
      return mockMintProofs();
    }
    createMintQuoteBolt11 = jest.fn(async () => ({ quote: "q1" }));
    checkMintQuoteBolt11 = jest.fn(async () => ({ state: "PAID" }));
    // handleCashuPayment filters wallet proofs to this mint's keysets — the
    // fixture proof ids must be members.
    keyChain = {
      getKeysets: jest.fn(async () => [{ id: "009a1f293253e41e" }]),
    };
  }
  return { ...actual, Mint: MockMint, Wallet: MockWallet };
});

// ── Lightweight HeroUI stubs (same pattern as the fx-placeholder tests) ─────
jest.mock(
  "@heroui/react",
  () => {
    const passthrough =
      (tag: string) =>
      ({ children, ...props }: { children?: ReactNode }) => {
        const {
          onPress: _onPress,
          startContent,
          endContent,
          ...rest
        } = props as Record<string, unknown>;
        return (
          <div data-hero={tag} {...(rest as object)}>
            {startContent as ReactNode}
            {children}
            {endContent as ReactNode}
          </div>
        );
      };
    return {
      __esModule: true,
      Button: passthrough("button"),
      Image: ({ alt }: { src?: string; alt?: string }) => (
        <div data-hero="image" aria-label={alt} />
      ),
      Modal: passthrough("modal"),
      ModalContent: passthrough("modal-content"),
      ModalHeader: passthrough("modal-header"),
      ModalBody: passthrough("modal-body"),
      ModalFooter: passthrough("modal-footer"),
      Select: passthrough("select"),
      SelectItem: passthrough("select-item"),
      Input: passthrough("input"),
      Spinner: () => <div data-testid="spinner" />,
      Checkbox: passthrough("checkbox"),
      useDisclosure: () => ({
        isOpen: false,
        onOpen: jest.fn(),
        onClose: jest.fn(),
      }),
    };
  },
  { virtual: true }
);

// Heavy child components are irrelevant to the escrow backup wiring.
jest.mock("@/components/utility-components/wallet-recovery-modal", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/utility-components/payment-countdown", () => ({
  __esModule: true,
  PaymentCountdown: () => null,
  PaymentElapsed: () => null,
}));
jest.mock("@/components/utility-components/failure-modal", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/utility-components/stripe-card-form", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/utility-components/dropdowns/country-dropdown", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/utility-components/address-picker", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/sign-in/SignInModal", () => ({
  __esModule: true,
  default: () => null,
}));

const MINT = "https://mint.example";
const WALLET_PROOF = {
  id: "009a1f293253e41e",
  amount: 8192,
  secret: "buyer-wallet-proof",
  C: "02" + "ef".repeat(32),
};

// Avoid real key generation / relay / localStorage side effects on mount; the
// wallet holds one funded proof so the Cashu option renders.
jest.mock("@/utils/nostr/nostr-helper-functions", () => ({
  __esModule: true,
  // Must be REAL bech32 — the inquiry-DM path nip19.decodes the sender nsec.
  generateKeys: jest.fn(async () => ({
    nsec: "nsec1eslh2h959see4zm7qe7utnh9g0drmshaaesdc7q6pdnk5ng4zexq458qpa",
    npub: "npub1zuu0caepddatvz8pmyklsprqec2em4dlkkftslu0spdxkrzd3x9s3alhxc",
  })),
  getLocalStorageData: jest.fn(() => ({
    mints: [MINT],
    tokens: [WALLET_PROOF],
    history: [],
    nwcInfo: "",
  })),
  getSavedAddresses: jest.fn(() => []),
  saveAddress: jest.fn(),
  constructGiftWrappedEvent: jest.fn(),
  constructMessageSeal: jest.fn(),
  constructMessageGiftWrap: jest.fn(),
  sendGiftWrappedMessageEvent: jest.fn(),
  publishProofEvent: jest.fn(),
}));

jest.mock("@milk-market/nostr", () => ({
  __esModule: true,
  createSellerActionAuthEventTemplate: jest.fn(() => ({})),
}));

import ProductInvoiceCard from "@/components/product-invoice-card";
import type { ProductData } from "@/utils/parsers/product-parser-functions";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { ShopMapContext } from "@/utils/context/context";

const sellerPubkey = "b".repeat(64);
const buyerSecret = generateSecretKey();
const buyerPk = getPublicKey(buyerSecret);
// The commitment event is REALLY signed — only the HTTP seams are mocked.
const buyerSigner = {
  _getPrivKey: async () => buyerSecret,
  sign: jest.fn((template: EventTemplate) =>
    finalizeEvent(template, buyerSecret)
  ),
};

function buildProductData(overrides: Partial<ProductData> = {}): ProductData {
  return {
    id: "product-id",
    pubkey: sellerPubkey,
    createdAt: 1710000000,
    title: "Raw Whole Milk",
    summary: "A gallon of fresh raw milk",
    publishedAt: "",
    images: ["https://example.com/milk.png"],
    categories: [],
    location: "",
    // Priced in sats so no FX conversion runs on the submit path — a NaN
    // price silently skips the entire seller/escrow block (NaN > 0 is false).
    price: 5000,
    currency: "sats",
    totalCost: 5000,
    // "N/A" auto-selects the contact order form (no required fields), so the
    // test can submit without filling shipping inputs.
    shippingType: "N/A",
    ...overrides,
  } as ProductData;
}

const noopSetters = {
  setIsBeingPaid: jest.fn(),
  setFiatOrderIsPlaced: jest.fn(),
  setFiatOrderFailed: jest.fn(),
  setInvoiceIsPaid: jest.fn(),
  setInvoiceGenerationFailed: jest.fn(),
  setCashuPaymentSent: jest.fn(),
  setCashuPaymentFailed: jest.fn(),
};

function renderCard() {
  return render(
    <SignerContext.Provider
      value={
        {
          signer: buyerSigner,
          pubkey: buyerPk,
          // Must be REAL bech32 — the inquiry-DM path nip19.decodes it.
          npub: nip19.npubEncode(buyerPk),
          isLoggedIn: true,
        } as never
      }
    >
      <ShopMapContext.Provider
        value={
          {
            shopData: new Map([
              [
                sellerPubkey,
                { content: { storefront: { acceptsEscrow: true } } },
              ],
            ]),
            isLoading: false,
            shopError: null,
          } as never
        }
      >
        <ProductInvoiceCard productData={buildProductData()} {...noopSetters} />
      </ShopMapContext.Provider>
    </SignerContext.Provider>
  );
}

beforeAll(() => {
  // checkSellerStripe() fetches on mount; return a benign non-merchant result.
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ hasStripeAccount: false, chargesEnabled: false }),
  })) as unknown as typeof fetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  process.env.NEXT_PUBLIC_CASHU_ESCROW_ENABLED = "true";
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_CASHU_ESCROW_ENABLED;
});

async function payViaEscrow() {
  renderCard();
  const escrowToggle = await screen.findByText("Pay via escrow");
  fireEvent.click(
    escrowToggle.closest("label")!.querySelector("input[type=checkbox]")!
  );
  const payButton = await screen.findByText(/Pay with Cashu/);
  fireEvent.click(payButton);
  await waitFor(() => expect(publishEscrowBackupMock).toHaveBeenCalled(), {
    timeout: 4000,
  });
}

describe("ProductInvoiceCard escrow backup warning", () => {
  it("warns the buyer when the recovery backup cannot be published", async () => {
    publishEscrowBackupMock.mockResolvedValue({
      published: false,
      failure: "encryption_failed",
    });

    await payViaEscrow();

    expect(await screen.findByText(/no recovery backup/i)).toBeInTheDocument();
  });

  it("renders no warning when the backup publishes", async () => {
    publishEscrowBackupMock.mockResolvedValue({ published: true });

    await payViaEscrow();

    expect(screen.queryByText(/no recovery backup/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/could not be backed up/i)
    ).not.toBeInTheDocument();
  });
});
