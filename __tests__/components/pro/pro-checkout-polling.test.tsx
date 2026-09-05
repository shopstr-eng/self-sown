/** @jest-environment jsdom */

import { render, screen, fireEvent, act } from "@testing-library/react";
import ProCheckout from "@/components/pro/pro-checkout";
import { useProMembership } from "@/components/utility-components/pro-membership-context";

jest.mock("qrcode", () => ({
  __esModule: true,
  default: {
    toDataURL: jest.fn(() => Promise.resolve("data:image/png;base64,x")),
  },
}));
jest.mock("@/components/utility-components/stripe-card-form", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/utility-components/pro-membership-context", () => ({
  useProMembership: jest.fn(),
}));

const mockUseProMembership = useProMembership as jest.Mock;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ProCheckout Bitcoin invoice polling", () => {
  const verifyManualInvoice = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    verifyManualInvoice.mockReset();
    (window as any).umami = { track: jest.fn() };
    mockUseProMembership.mockReturnValue({
      membership: { status: "free", term: "yearly" },
      startFreeTrial: jest.fn(),
      startStripeSubscription: jest.fn(),
      startStripeLifetime: jest.fn(),
      syncStripe: jest.fn(),
      createManualInvoice: jest.fn(async () => ({
        invoiceId: "inv-1",
        bolt11: "lnbc1testinvoice",
      })),
      createManualLifetimeInvoice: jest.fn(),
      verifyManualInvoice,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete (window as any).umami;
  });

  it("overlapping paid poll resolutions complete exactly once", async () => {
    const onComplete = jest.fn();
    render(<ProCheckout onComplete={onComplete} />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /pay with bitcoin/i })
      );
    });
    // handleManual resolved inside act: the invoice is set and the 4s poll
    // effect is now running.

    // Two polls go in flight before EITHER verification resolves (the
    // interval fires regardless of a pending request).
    const first = deferred<{ paid: boolean }>();
    const second = deferred<{ paid: boolean }>();
    verifyManualInvoice
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    expect(verifyManualInvoice).toHaveBeenCalledTimes(2);

    // The first poll observes paid, then the still-in-flight second poll ALSO
    // resolves paid — only one completion may be recorded.
    await act(async () => {
      first.resolve({ paid: true });
    });
    await act(async () => {
      second.resolve({ paid: true });
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("paid");
    // The click itself legitimately fired pro_checkout_started — the guard is
    // about pro_subscribed firing exactly once despite two paid resolutions.
    const track = (window as any).umami.track as jest.Mock;
    const subscribed = track.mock.calls.filter(
      (c) => c[0] === "pro_subscribed"
    );
    expect(subscribed).toHaveLength(1);
    expect(subscribed[0]![1]).toEqual({ method: "bitcoin", plan: "yearly" });
    expect(track).toHaveBeenCalledWith("pro_checkout_started", {
      method: "bitcoin",
      plan: "yearly",
    });
  });
});
