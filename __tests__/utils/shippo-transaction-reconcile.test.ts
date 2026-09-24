/**
 * Contract test for Shippo transaction reconciliation. Real Shippo
 * Transaction payloads carry NO shipment id — purchases stamp a fixed-length
 * reconcile token into `metadata`, and the finder must match on exactly that
 * token, treat WAITING/QUEUED matches as in-flight (never "no charge"), and
 * only report "no charge" when the scan covered the claim's charge window.
 */
import { findSuccessfulTransactionForShipment } from "@/utils/shipping/shippo";

const TOKEN = "a1".repeat(32); // realistic 64-char sha256 hex
const OTHER_TOKEN = "b2".repeat(32);
const NOW = Date.now();
const SINCE_MS = NOW - 60_000;

function tx(over: Record<string, unknown>) {
  return {
    object_id: "tx_1",
    status: "SUCCESS",
    metadata: TOKEN,
    object_created: new Date(NOW - 30_000).toISOString(),
    label_url: "https://shippo.test/label.pdf",
    label_file_type: "PDF",
    tracking_number: "TRK1",
    tracking_url_provider: "https://track.test/TRK1",
    rate: {
      amount: "7.50",
      currency: "USD",
      provider: "USPS",
      servicelevel: { token: "usps_priority", name: "Priority Mail" },
    },
    ...over,
  };
}

const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (global as { fetch: unknown }).fetch = fetchMock;
});

function mockPages(
  ...pages: Array<{ results: unknown[]; next: string | null }>
) {
  let i = 0;
  fetchMock.mockImplementation(async () => ({
    ok: true,
    text: async () => JSON.stringify(pages[Math.min(i++, pages.length - 1)]),
  }));
}

const ARGS = {
  accessToken: "shippo_test_token",
  shipmentId: "shp_123",
  reconcileToken: TOKEN,
  sinceMs: SINCE_MS,
};

describe("findSuccessfulTransactionForShipment (Shippo payload contract)", () => {
  it("matches a SUCCESS transaction by exact metadata token", async () => {
    mockPages({ results: [tx({})], next: null });
    const lookup = await findSuccessfulTransactionForShipment(ARGS);
    expect(lookup.label?.trackingCode).toBe("TRK1");
    expect(lookup.label?.rate).toBe(7.5);
    expect(lookup.label?.carrier).toBe("USPS");
    expect(lookup.label?.service).toBe("Priority Mail");
    expect(lookup.coveredWindow).toBe(true);
    expect(lookup.hasInFlight).toBe(false);
  });

  it("ignores SUCCESS transactions stamped with a different token", async () => {
    mockPages({
      results: [tx({ metadata: OTHER_TOKEN, object_id: "tx_other" })],
      next: null,
    });
    const lookup = await findSuccessfulTransactionForShipment(ARGS);
    expect(lookup.label).toBeNull();
    // The list was exhausted, so the window is covered by definition.
    expect(lookup.coveredWindow).toBe(true);
  });

  it("treats a matching WAITING transaction as in-flight, never as no-charge", async () => {
    mockPages({
      results: [tx({ status: "WAITING", label_url: null, object_id: "tx_w" })],
      next: null,
    });
    const lookup = await findSuccessfulTransactionForShipment(ARGS);
    expect(lookup.label).toBeNull();
    expect(lookup.hasInFlight).toBe(true);
  });

  it("pages until transactions older than the claim window are reached", async () => {
    mockPages(
      {
        results: [tx({ metadata: OTHER_TOKEN })],
        next: "https://api.goshippo.com/transactions/?page=2",
      },
      {
        results: [
          tx({
            metadata: OTHER_TOKEN,
            object_created: new Date(NOW - 3_600_000).toISOString(),
          }),
        ],
        next: null,
      }
    );
    const lookup = await findSuccessfulTransactionForShipment(ARGS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lookup.label).toBeNull();
    expect(lookup.coveredWindow).toBe(true);
  });

  it("reports coveredWindow=false when the page cap is hit before the window", async () => {
    mockPages({
      results: [tx({ metadata: OTHER_TOKEN })],
      next: "https://api.goshippo.com/transactions/?page=2",
    });
    const lookup = await findSuccessfulTransactionForShipment(ARGS);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(lookup.label).toBeNull();
    expect(lookup.coveredWindow).toBe(false);
  });
});
