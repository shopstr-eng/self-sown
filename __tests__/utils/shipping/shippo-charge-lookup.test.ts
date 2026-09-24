/**
 * @jest-environment node
 */

// Unit coverage for lookupShipmentCharge — the reconciliation lookup every
// ambiguous label purchase depends on. These states decide whether a held
// claim may EVER be released for a retry, so each one guards seller money:
//
//   - SUCCESS with label metadata   → "charged" with a reconstructable label
//   - SUCCESS WITHOUT label_url     → "charged" with label null (buyLabel
//     throws on this exact response; the seller was billed regardless)
//   - REFUNDED / REFUNDPENDING      → "charged" (money moved, then reversed)
//   - WAITING / QUEUED / unknown    → "in-flight" (may still succeed —
//     fail closed)
//   - ERROR / REFUNDREJECTED        → terminal failure, not a charge
//   - no matching transaction       → "none"
//   - page cap before the window    → coveredWindow false (proves nothing)
//   - in-flight on a newer page must NOT hide a charge on an older page

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

import { lookupShipmentCharge } from "@/utils/shipping/shippo";

const TOKEN = "oauth.test-token";
const SHIPMENT = "shp_target";
const RECONCILE = "rec_tok_target";
const SINCE = Date.parse("2026-01-01T00:00:00Z");

function lookup() {
  return lookupShipmentCharge({
    accessToken: TOKEN,
    shipmentId: SHIPMENT,
    reconcileToken: RECONCILE,
    sinceMs: SINCE,
  });
}

function tx(overrides: Record<string, unknown>) {
  return {
    object_id: "tx_1",
    status: "SUCCESS",
    shipment: SHIPMENT,
    metadata: RECONCILE,
    object_created: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

// A full label payload with an embedded rate object so no rate detail fetch
// is needed.
function successTx(overrides: Record<string, unknown> = {}) {
  return tx({
    label_url: "https://labels.example/label.pdf",
    label_file_type: "PDF",
    tracking_number: "TRK1",
    tracking_url_provider: "https://track.example/TRK1",
    rate: {
      object_id: "rate_1",
      amount: "7.50",
      currency: "USD",
      provider: "USPS",
      servicelevel: { token: "usps_priority", name: "Priority Mail" },
    },
    ...overrides,
  });
}

function pageWith(results: unknown[], next: string | null = null) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ results, next }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("lookupShipmentCharge", () => {
  it("SUCCESS with label metadata → charged with a reconstructed label", async () => {
    fetchMock.mockResolvedValueOnce(pageWith([successTx()]));

    const result = await lookup();

    expect(result.chargeState).toBe("charged");
    expect(result.coveredWindow).toBe(true);
    expect(result.label).toMatchObject({
      shipmentId: SHIPMENT,
      trackingCode: "TRK1",
      labelUrl: "https://labels.example/label.pdf",
      rate: 7.5,
      currency: "USD",
      carrier: "USPS",
      service: "Priority Mail",
    });
  });

  it("SUCCESS WITHOUT label_url → charged with a null label (money was spent)", async () => {
    fetchMock.mockResolvedValueOnce(
      pageWith([successTx({ label_url: undefined })])
    );

    const result = await lookup();

    expect(result.chargeState).toBe("charged");
    expect(result.label).toBeNull();
  });

  it("REFUNDED / REFUNDPENDING → charged (the charge landed before reversal)", async () => {
    for (const status of ["REFUNDED", "REFUNDPENDING"]) {
      fetchMock.mockResolvedValueOnce(pageWith([tx({ status })]));
      const result = await lookup();
      expect(result.chargeState).toBe("charged");
    }
  });

  it("WAITING / QUEUED / unknown nonterminal → in-flight (fail closed)", async () => {
    for (const status of ["WAITING", "QUEUED", "SOME_FUTURE_STATUS"]) {
      fetchMock.mockResolvedValueOnce(pageWith([tx({ status })]));
      const result = await lookup();
      expect(result.chargeState).toBe("in-flight");
      expect(result.coveredWindow).toBe(true);
      expect(result.label).toBeNull();
    }
  });

  it("ERROR / REFUNDREJECTED → none (terminal failure, no charge)", async () => {
    for (const status of ["ERROR", "REFUNDREJECTED"]) {
      fetchMock.mockResolvedValueOnce(pageWith([tx({ status })]));
      const result = await lookup();
      expect(result.chargeState).toBe("none");
      expect(result.coveredWindow).toBe(true);
    }
  });

  it("no matching transaction → none, covered when the window is reached", async () => {
    fetchMock.mockResolvedValueOnce(
      pageWith([tx({ metadata: "rec_tok_other" })])
    );

    const result = await lookup();

    expect(result.chargeState).toBe("none");
    expect(result.coveredWindow).toBe(true);
  });

  it("transactions stamped with another reconcile token never count as a charge", async () => {
    fetchMock.mockResolvedValueOnce(
      pageWith([successTx({ metadata: "rec_tok_other" })])
    );

    const result = await lookup();

    expect(result.chargeState).toBe("none");
  });

  it("an in-flight transaction on a newer page never hides a charge on an older page", async () => {
    // Newest-first: page 1 has a QUEUED retry for the shipment, page 2 holds
    // the original SUCCESS. The scan must keep paging and find the charge.
    fetchMock
      .mockResolvedValueOnce(
        pageWith(
          [tx({ status: "QUEUED", object_created: "2026-02-02T00:00:00Z" })],
          "https://api.goshippo.com/transactions/?page=2"
        )
      )
      .mockResolvedValueOnce(pageWith([successTx()]));

    const result = await lookup();

    expect(result.chargeState).toBe("charged");
    expect(result.label).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a terminal failure on a newer page never hides a charge on an older page", async () => {
    fetchMock
      .mockResolvedValueOnce(
        pageWith(
          [tx({ status: "ERROR", object_created: "2026-02-02T00:00:00Z" })],
          "https://api.goshippo.com/transactions/?page=2"
        )
      )
      .mockResolvedValueOnce(pageWith([successTx()]));

    const result = await lookup();

    expect(result.chargeState).toBe("charged");
  });

  it("hitting the page cap before the window reports coveredWindow=false but still fails closed on an in-flight sighting", async () => {
    // Every page is newer than `since` and links onward, so the cap is hit.
    for (let page = 0; page < 8; page++) {
      fetchMock.mockResolvedValueOnce(
        pageWith(
          [
            tx({
              status: page === 0 ? "WAITING" : "ERROR",
              object_created: "2026-06-01T00:00:00Z",
            }),
          ],
          `https://api.goshippo.com/transactions/?page=${page + 2}`
        )
      );
    }

    const result = await lookup();

    expect(result.coveredWindow).toBe(false);
    expect(result.chargeState).toBe("in-flight");
    expect(result.label).toBeNull();
  });

  it("coveredWindow=false with no sighting reports none-but-unproven", async () => {
    for (let page = 0; page < 8; page++) {
      fetchMock.mockResolvedValueOnce(
        pageWith(
          [tx({ metadata: "rec_tok_other", object_created: "2026-06-01T00:00:00Z" })],
          `https://api.goshippo.com/transactions/?page=${page + 2}`
        )
      );
    }

    const result = await lookup();

    expect(result.coveredWindow).toBe(false);
    expect(result.chargeState).toBe("none");
  });
});
