/** @jest-environment node */

// Tests for refetchStripeConnectStatusUntilSettled. Stripe flips
// charges_enabled asynchronously after hosted onboarding redirects back to
// the app, and openAuthSessionAsync consumes the return URL so the
// deep-link route's own refetch usually never fires — a single immediate
// refetch (or none) left the dashboard showing "not connected" until the
// seller tapped Connect Stripe a second time and re-answered the form. The
// helper must poll briefly until charges confirm, without burning the
// budget when polling can't help (error result, or a "refresh" return).

jest.mock(
  "expo-linking",
  () => ({ createURL: jest.fn(), parse: jest.fn() }),
  { virtual: true }
);

const { refetchStripeConnectStatusUntilSettled } =
  require("../../apps/mobile/lib/stripe-connect") as typeof import("../../apps/mobile/lib/stripe-connect");

type Status = { chargesEnabled?: boolean };

const enabled = (): { data: Status } => ({ data: { chargesEnabled: true } });
const disabled = (): { data: Status } => ({ data: { chargesEnabled: false } });

describe("refetchStripeConnectStatusUntilSettled", () => {
  it("returns the first result without polling when charges are already live", async () => {
    const refetch = jest.fn(async () => enabled());

    const result = await refetchStripeConnectStatusUntilSettled(refetch, {
      delayMs: 0,
    });

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(result.data?.chargesEnabled).toBe(true);
  });

  it("polls until charges flip, returning the settled result", async () => {
    const refetch = jest
      .fn()
      .mockImplementationOnce(async () => disabled())
      .mockImplementationOnce(async () => disabled())
      .mockImplementationOnce(async () => enabled());

    const result = await refetchStripeConnectStatusUntilSettled(refetch, {
      delayMs: 0,
    });

    expect(refetch).toHaveBeenCalledTimes(3);
    expect(result.data?.chargesEnabled).toBe(true);
  });

  it("stops after the attempt budget when charges never flip", async () => {
    const refetch = jest.fn(async () => disabled());

    const result = await refetchStripeConnectStatusUntilSettled(refetch, {
      attempts: 3,
      delayMs: 0,
    });

    expect(refetch).toHaveBeenCalledTimes(3);
    expect(result.data?.chargesEnabled).toBe(false);
  });

  it("does not poll past an error result", async () => {
    const failure = new Error("boom");
    const refetch = jest.fn(async () => ({ error: failure }));

    const result = await refetchStripeConnectStatusUntilSettled(refetch, {
      delayMs: 0,
    });

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(result.error).toBe(failure);
  });

  it("honors attempts: 1 for returns where polling cannot help", async () => {
    const refetch = jest.fn(async () => disabled());

    await refetchStripeConnectStatusUntilSettled(refetch, {
      attempts: 1,
      delayMs: 0,
    });

    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
