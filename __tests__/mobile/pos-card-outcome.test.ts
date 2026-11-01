/** @jest-environment node */

// A confirmPaymentIntent error is ambiguous: the payment may have been
// captured anyway. Only a confirmed non-payment may produce a "no charge"
// receipt; an unknown outcome must stop the seller from retrying blindly.

import { classifyConfirmFailure } from "../../apps/mobile/lib/pos-card-outcome";

describe("classifyConfirmFailure", () => {
  it("treats succeeded and requiresCapture as approved", () => {
    expect(classifyConfirmFailure("succeeded")).toBe("approved");
    expect(classifyConfirmFailure("requiresCapture")).toBe("approved");
  });

  it("treats canceled and requiresPaymentMethod as not approved", () => {
    expect(classifyConfirmFailure("canceled")).toBe("not-approved");
    expect(classifyConfirmFailure("requiresPaymentMethod")).toBe(
      "not-approved"
    );
  });

  it("treats in-flight or unreadable statuses as unknown", () => {
    expect(classifyConfirmFailure("processing")).toBe("unknown");
    expect(classifyConfirmFailure("requiresConfirmation")).toBe("unknown");
    expect(classifyConfirmFailure("requiresAction")).toBe("unknown");
    expect(classifyConfirmFailure(undefined)).toBe("unknown");
  });
});
