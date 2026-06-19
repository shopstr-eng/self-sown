/** @jest-environment node */

// Unit coverage for the DB-free UCP checkout status lifecycle + variant decoder
// (utils/ucp/checkout-status.ts). These are the single source of truth shared by
// the REST routes and the Postgres store, so the reconcile mapping and the
// variant-id decoding must stay exactly aligned with the order engine.

import {
  CHECKOUT_STATUSES,
  TERMINAL_CHECKOUT_STATUSES,
  reconcileStatusFromOrder,
  decodeVariantId,
  type CheckoutSessionStatus,
} from "@/utils/ucp/checkout-status";

describe("checkout status constants", () => {
  it("lists the six UCP lifecycle statuses in order", () => {
    expect(CHECKOUT_STATUSES).toEqual([
      "incomplete",
      "ready_for_complete",
      "complete_in_progress",
      "completed",
      "requires_escalation",
      "canceled",
    ]);
  });

  it("treats only completed + canceled as terminal", () => {
    expect(TERMINAL_CHECKOUT_STATUSES).toEqual(["completed", "canceled"]);
  });
});

describe("reconcileStatusFromOrder", () => {
  const current: CheckoutSessionStatus = "ready_for_complete";

  it("maps paid → completed", () => {
    expect(reconcileStatusFromOrder(current, "paid")).toBe("completed");
  });

  it("maps processing → complete_in_progress", () => {
    expect(reconcileStatusFromOrder(current, "processing")).toBe(
      "complete_in_progress"
    );
  });

  it("maps failed → requires_escalation", () => {
    expect(reconcileStatusFromOrder(current, "failed")).toBe(
      "requires_escalation"
    );
  });

  it("maps refunded/cancelled/canceled → canceled", () => {
    expect(reconcileStatusFromOrder(current, "refunded")).toBe("canceled");
    expect(reconcileStatusFromOrder(current, "cancelled")).toBe("canceled");
    expect(reconcileStatusFromOrder(current, "canceled")).toBe("canceled");
  });

  it("keeps the current status when the order has not advanced", () => {
    expect(reconcileStatusFromOrder(current, "pending")).toBe(current);
    expect(reconcileStatusFromOrder(current, null)).toBe(current);
    expect(reconcileStatusFromOrder(current, undefined)).toBe(current);
    expect(reconcileStatusFromOrder("complete_in_progress", "unknown")).toBe(
      "complete_in_progress"
    );
  });
});

describe("decodeVariantId", () => {
  it("decodes priced/inventoried dimensions to selection fields", () => {
    expect(decodeVariantId("size:1 Gallon")).toEqual({
      ok: true,
      selectedSize: "1 Gallon",
    });
    expect(decodeVariantId("volume:500ml")).toEqual({
      ok: true,
      selectedVolume: "500ml",
    });
    expect(decodeVariantId("weight:2 lb")).toEqual({
      ok: true,
      selectedWeight: "2 lb",
    });
  });

  it("is case-insensitive on the dimension and trims the value", () => {
    expect(decodeVariantId("SIZE:  1 Gallon ")).toEqual({
      ok: true,
      selectedSize: "1 Gallon",
    });
  });

  it("accepts a descriptive variant: id as a no-op selection", () => {
    expect(decodeVariantId("variant:Gift Wrap")).toEqual({ ok: true });
  });

  it("rejects empty, prefix-less, and unknown-dimension ids", () => {
    expect(decodeVariantId("").ok).toBe(false);
    expect(decodeVariantId("   ").ok).toBe(false);
    expect(decodeVariantId("1 Gallon").ok).toBe(false);
    expect(decodeVariantId(":nodimension").ok).toBe(false);
    expect(decodeVariantId("size:").ok).toBe(false);
    expect(decodeVariantId("color:red").ok).toBe(false);
  });
});
