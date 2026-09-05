/**
 * @jest-environment jsdom
 *
 * Component coverage for the escrow backup warning on CartInvoiceCard.
 *
 * When a buyer pays via escrow, the card backs the locked proofs up to the
 * buyer's kind-7375 wallet events (publishEscrowBackup). A backup that can
 * never publish (e.g. a remote signer without NIP-44) leaves a lost browser
 * unrecoverable, so the card must surface describeEscrowBackupWarning's text
 * in a view the buyer actually sees: the direct Cashu path never opens the
 * invoice view (showInvoiceCard stays false), so the banner must render in
 * the main payment view. This test pins the wiring: { published: false,
 * failure: "encryption_failed" } renders the warning; { published: true }
 * renders none.
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
// Amount survives the module mock below (it spreads ...actual), so fixtures
// get REAL cashu-ts v4 Amount instances — the cart path Amount.from()s them.
import { Amount } from "@cashu/cashu-ts";

// ── FX helpers: fixed rate so any fiat approximation resolves ───────────────
jest.mock("@/utils/stripe/currency", () => {
  const actual = jest.requireActual("@/utils/stripe/currency");
  return {
    ...actual,
    getSatoshiValueResilient: jest.fn(async () => 5000),
    getFiatValueResilient: jest.fn(async () => 10),
    getSatoshiValue: jest.fn(async () => 5000),
  };
});

// ── Escrow backup seam: controlled result, REAL warning text ────────────────
const publishEscrowBackupMock = jest.fn();
jest.mock("@/utils/cashu/escrow-backup", () => {
  const actual = jest.requireActual("@/utils/cashu/escrow-backup");
  return {
    ...actual,
    publishEscrowBackup: (...args: unknown[]) =>
      publishEscrowBackupMock(...args),
  };
});

// ── Escrow checkout seams: gate stays REAL; registration is the only stub ───
// NOTE: the card imports registerEscrowCommitmentWithServer from
// escrow-checkout (and publishEscrowBackup from escrow-backup) — mocking the
// wrong module silently lets the real server call through.
jest.mock("@/utils/cashu/escrow-checkout", () => {
  const actual = jest.requireActual("@/utils/cashu/escrow-checkout");
  return {
    ...actual,
    registerEscrowCommitmentWithServer: jest.fn(async () => ({
      escrowId: "escrow-test-1",
    })),
  };
});

// ── Mint-side swap: return a fixture locked output without a mint ────────────
// The cart's sendTokens reads proof amounts as cashu-ts v4 Amount objects
// (.toNumber() / Amount.from()) — plain numbers throw in the sweep math.
const LOCKED_PROOF = {
  id: "009a1f293253e41e",
  amount: Amount.from(5000),
  secret: "locked-escrow-proof-secret",
  C: "02" + "ab".repeat(32),
};
jest.mock("@/utils/cashu/swap-retry-service", () => {
  const actual = jest.requireActual("@/utils/cashu/swap-retry-service");
  return {
    ...actual,
    safeSwap: jest.fn(async () => ({
      status: "swapped",
      keep: [],
      send: [LOCKED_PROOF],
    })),
  };
});

// ── Mint transport: stub only the classes, keep the rest of cashu-ts real ───
jest.mock("@cashu/cashu-ts", () => {
  const actual = jest.requireActual("@cashu/cashu-ts");
  class MockMint {
    constructor(public url: string) {}
  }
  class MockWallet {
    constructor(public mint: unknown) {}
    loadMint = jest.fn(async () => undefined);
    mintProofsBolt11 = jest.fn(async () => [
      {
        id: "009a1f293253e41e",
        amount: 8192,
        secret: "funded-proof",
        C: "02" + "cd".repeat(32),
      },
    ]);
    createMintQuoteBolt11 = jest.fn(async () => ({ quote: "q1" }));
    checkMintQuoteBolt11 = jest.fn(async () => ({ state: "PAID" }));
    // Called SYNCHRONOUSLY (no await) and the fee is a real Amount — a
    // promise or plain number both break the .toNumber() call site.
    getFeesForProofs = jest.fn(() => Amount.from(0));
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

// ESM-flavored leaf libs the cart imports at module load but never exercises
// in this render path — stub so importing the component never trips the
// transformer.
jest.mock("@getalby/sdk", () => ({
  __esModule: true,
  NostrWebLNProvider: class {},
}));
jest.mock("qrcode", () => ({
  __esModule: true,
  default: { toDataURL: jest.fn(async () => "data:image/png;base64,stub") },
}));
jest.mock("uuid", () => ({
  __esModule: true,
  v4: () => "00000000-0000-0000-0000-000000000000",
}));

const MINT = "https://mint.example";
const WALLET_PROOF = {
  id: "009a1f293253e41e",
  amount: Amount.from(8192),
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
  // The cart MUTATES `.tags` on the built events, so these must return real
  // event-shaped objects, not undefined.
  constructGiftWrappedEvent: jest.fn(() => ({
    kind: 14,
    tags: [],
    content: "",
    pubkey: "",
    created_at: 0,
  })),
  constructMessageSeal: jest.fn(() => ({
    kind: 13,
    tags: [],
    content: "",
    pubkey: "",
    created_at: 0,
  })),
  constructMessageGiftWrap: jest.fn(() => ({
    kind: 1059,
    tags: [],
    content: "",
    pubkey: "",
    created_at: 0,
  })),
  sendGiftWrappedMessageEvent: jest.fn(),
  publishProofEvent: jest.fn(),
}));

jest.mock("@milk-market/nostr", () => ({
  __esModule: true,
  createSellerActionAuthEventTemplate: jest.fn(() => ({})),
}));

import CartInvoiceCard from "@/components/cart-invoice-card";
import type { ProductData } from "@/utils/parsers/product-parser-functions";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { ShopMapContext } from "@/utils/context/context";

const SELLER_PUBKEY = "b".repeat(64);
const PRODUCT_ID = "product-id";
const buyerSecret = generateSecretKey();
const buyerPk = getPublicKey(buyerSecret);
// The commitment event is REALLY signed — only the HTTP seams are mocked.
const buyerSigner = {
  _getPrivKey: async () => buyerSecret,
  sign: jest.fn((template: EventTemplate) =>
    finalizeEvent(template, buyerSecret)
  ),
};

function buildSatsProduct(overrides: Partial<ProductData> = {}): ProductData {
  return {
    id: PRODUCT_ID,
    pubkey: SELLER_PUBKEY,
    createdAt: 1710000000,
    title: "Raw Whole Milk",
    summary: "A gallon of fresh raw milk",
    publishedAt: "",
    images: ["https://example.com/milk.png"],
    categories: [],
    location: "",
    // Sats pricing keeps FX conversion off the submit path entirely.
    price: 5000,
    currency: "sats",
    totalCost: 5000,
    // "Pickup" auto-selects the contact order form (no required fields).
    shippingType: "Pickup",
    ...overrides,
  } as ProductData;
}

const noopSetters = {
  setInvoiceIsPaid: jest.fn(),
  setInvoiceGenerationFailed: jest.fn(),
  setCashuPaymentSent: jest.fn(),
  setCashuPaymentFailed: jest.fn(),
};

function renderCart() {
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
                SELLER_PUBKEY,
                { content: { storefront: { acceptsEscrow: true } } },
              ],
            ]),
            isLoading: false,
            shopError: null,
          } as never
        }
      >
        <CartInvoiceCard
          products={[buildSatsProduct()]}
          quantities={{ [PRODUCT_ID]: 1 }}
          shippingTypes={{ [PRODUCT_ID]: "Pickup" }}
          totalCostsInSats={{ [PRODUCT_ID]: 5000 }}
          // Per-item sat prices: the Cashu path fails closed when any item
          // is unpriced, so the prop must cover every product.
          satPrices={{ [PRODUCT_ID]: 5000 }}
          subtotalCost={5000}
          {...noopSetters}
        />
      </ShopMapContext.Provider>
    </SignerContext.Provider>
  );
}

beforeAll(() => {
  // The Stripe-merchant check fetches on mount; report a benign result.
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
  renderCart();
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

describe("CartInvoiceCard escrow backup warning", () => {
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
