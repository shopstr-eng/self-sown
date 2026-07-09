import {
  derivePaymentPreference,
  isDirectLightningCandidate,
  requestDirectLightningInvoice,
} from "@/utils/lightning/direct-lnurl";

const mockFetch = jest.fn();
const mockRequestInvoice = jest.fn();
let mockLnurlpData: { min: number; max: number } | undefined;

jest.mock("@getalby/lightning-tools", () => ({
  LightningAddress: jest.fn().mockImplementation(() => ({
    fetch: mockFetch,
    requestInvoice: mockRequestInvoice,
    get lnurlpData() {
      return mockLnurlpData;
    },
  })),
}));

describe("isDirectLightningCandidate", () => {
  it("accepts a normal lightning address", () => {
    expect(isDirectLightningCandidate("seller@getalby.com")).toBe(true);
  });

  it("rejects empty, missing, and non-address values", () => {
    expect(isDirectLightningCandidate("")).toBe(false);
    expect(isDirectLightningCandidate(undefined)).toBe(false);
    expect(isDirectLightningCandidate(null)).toBe(false);
    expect(isDirectLightningCandidate("   ")).toBe(false);
    expect(isDirectLightningCandidate("not-an-address")).toBe(false);
  });

  it("rejects zeuspay hold-invoice addresses (case-insensitive)", () => {
    expect(isDirectLightningCandidate("seller@zeuspay.com")).toBe(false);
    expect(isDirectLightningCandidate("seller@ZeusPay.com")).toBe(false);
  });
});

describe("derivePaymentPreference", () => {
  it("derives lightning when a usable lightning address is set", () => {
    expect(derivePaymentPreference("seller@getalby.com")).toBe("lightning");
  });

  it("derives ecash when no usable address is set", () => {
    expect(derivePaymentPreference(undefined)).toBe("ecash");
    expect(derivePaymentPreference("")).toBe("ecash");
    // zeuspay addresses are excluded from the direct path, so they don't
    // flip the preference either.
    expect(derivePaymentPreference("seller@zeuspay.com")).toBe("ecash");
  });

  it("derives fiat when Bitcoin payments are turned off, regardless of address", () => {
    expect(derivePaymentPreference("seller@getalby.com", false)).toBe("fiat");
    expect(derivePaymentPreference(undefined, false)).toBe("fiat");
  });
});

describe("requestDirectLightningInvoice", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLnurlpData = { min: 1000, max: 100_000_000 };
    mockRequestInvoice.mockResolvedValue({
      paymentRequest: "lnbc1...",
      verify: "https://example.com/verify/abc",
    });
  });

  it("returns the invoice when verify is supported", async () => {
    const result = await requestDirectLightningInvoice(
      " seller@getalby.com ",
      2100
    );
    expect(result).not.toBeNull();
    expect(result!.lnurl).toBe("seller@getalby.com");
    expect(mockRequestInvoice).toHaveBeenCalledWith({ satoshi: 2100 });
  });

  it("returns null when the invoice lacks LUD-21 verify (default gate)", async () => {
    mockRequestInvoice.mockResolvedValue({
      paymentRequest: "lnbc1...",
      verify: null,
    });
    expect(
      await requestDirectLightningInvoice("seller@getalby.com", 2100)
    ).toBeNull();
  });

  it("allows a verify-less invoice when requireVerify is false (NWC path)", async () => {
    mockRequestInvoice.mockResolvedValue({
      paymentRequest: "lnbc1...",
      verify: null,
    });
    expect(
      await requestDirectLightningInvoice("seller@getalby.com", 2100, {
        requireVerify: false,
      })
    ).not.toBeNull();
  });

  it("returns null when the amount is outside minSendable/maxSendable (msat bounds)", async () => {
    mockLnurlpData = { min: 10_000, max: 50_000 }; // 10-50 sats
    expect(
      await requestDirectLightningInvoice("seller@getalby.com", 5)
    ).toBeNull();
    expect(
      await requestDirectLightningInvoice("seller@getalby.com", 51)
    ).toBeNull();
    expect(
      await requestDirectLightningInvoice("seller@getalby.com", 50)
    ).not.toBeNull();
  });

  it("returns null on invalid amounts and zeuspay addresses without fetching", async () => {
    expect(
      await requestDirectLightningInvoice("seller@getalby.com", 0)
    ).toBeNull();
    expect(
      await requestDirectLightningInvoice("seller@getalby.com", NaN)
    ).toBeNull();
    expect(
      await requestDirectLightningInvoice("seller@zeuspay.com", 2100)
    ).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null (fallback to mint flow) when the LNURL fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));
    expect(
      await requestDirectLightningInvoice("seller@getalby.com", 2100)
    ).toBeNull();
  });

  it("returns null when lnurlpData is missing after fetch", async () => {
    mockLnurlpData = undefined;
    expect(
      await requestDirectLightningInvoice("seller@getalby.com", 2100)
    ).toBeNull();
  });
});
