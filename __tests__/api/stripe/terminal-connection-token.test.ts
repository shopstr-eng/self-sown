/** @jest-environment node */

// Route-level wiring for the Terminal-location ensure seam: a seller's first
// Tap to Pay attempt must not dead-end on "no Stripe Terminal location
// found". The connection-token route is scoped to the seller's own connected
// account, so it ensures a Terminal location exists there before issuing the
// token — and surfaces a clear, actionable error when it can't.

const connectionTokensCreate = jest.fn(
  async (..._a: unknown[]) => ({ secret: "pst_test" })
);
const ensureTerminalLocationMock = jest.fn();
const getStripeConnectAccountMock = jest.fn();

jest.mock("stripe", () => {
  const Stripe = jest.fn().mockImplementation(() => ({
    terminal: {
      connectionTokens: {
        create: (...a: unknown[]) => connectionTokensCreate(...a),
      },
    },
  }));
  return { __esModule: true, default: Stripe };
});

jest.mock("@/utils/stripe/ensure-terminal-location", () => ({
  ensureTerminalLocation: (...a: unknown[]) =>
    ensureTerminalLocationMock(...a),
}));

jest.mock("@/utils/db/db-service", () => ({
  getStripeConnectAccount: (...a: unknown[]) =>
    getStripeConnectAccountMock(...a),
}));

jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: jest.fn(async () => ({
    ok: true,
    pubkey: "a".repeat(64),
  })),
}));

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
}));

jest.mock("@/utils/self-host/config", () => ({
  getSelfHostConfig: () => ({ enabled: false }),
}));

jest.mock("@/utils/stripe/retry-service", () => ({
  withStripeRetry: (fn: () => Promise<unknown>) => fn(),
}));

import handler from "@/pages/api/stripe/terminal/connection-token";

const PUBKEY = "a".repeat(64);

function makeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

async function callHandler() {
  const res = makeRes();
  await handler({ method: "POST", body: {} } as any, res as any);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  getStripeConnectAccountMock.mockResolvedValue({
    stripe_account_id: "acct_seller",
    onboarding_complete: true,
    charges_enabled: true,
    payouts_enabled: true,
    tax_enabled: true,
    account_type: "express",
  });
  ensureTerminalLocationMock.mockResolvedValue({
    ok: true,
    locationId: "tml_1",
    created: false,
  });
});

describe("terminal connection-token route", () => {
  it("issues a token scoped to the seller's account once a location exists", async () => {
    const res = await callHandler();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ secret: "pst_test" });
    expect(ensureTerminalLocationMock).toHaveBeenCalledWith(
      expect.anything(),
      "acct_seller",
      PUBKEY
    );
    expect(connectionTokensCreate).toHaveBeenCalledWith(
      {},
      { stripeAccount: "acct_seller" }
    );
  });

  it("auto-creates the location on a first Tap to Pay attempt, then issues the token", async () => {
    ensureTerminalLocationMock.mockResolvedValue({
      ok: true,
      locationId: "tml_new",
      created: true,
    });

    const res = await callHandler();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ secret: "pst_test" });
  });

  it("returns a clear actionable error when the seller has no usable address", async () => {
    ensureTerminalLocationMock.mockResolvedValue({
      ok: false,
      code: "no_address",
      error:
        "Add your business address (finish Stripe onboarding, or Settings → Shipping) to enable Tap to Pay.",
    });

    const res = await callHandler();

    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe("terminal_location_missing");
    expect(res.body.error).toContain("business address");
    // Never leak a raw Stripe error, and never issue a token.
    expect(connectionTokensCreate).not.toHaveBeenCalled();
  });

  it("returns 502 when Stripe location setup fails", async () => {
    ensureTerminalLocationMock.mockResolvedValue({
      ok: false,
      code: "stripe_error",
      error: "Could not set up the card reader location",
    });

    const res = await callHandler();

    expect(res.statusCode).toBe(502);
    expect(res.body.code).toBe("terminal_location_failed");
    expect(connectionTokensCreate).not.toHaveBeenCalled();
  });

  it("issues a token for a Standard (seller-owned) connected account", async () => {
    // Tap to Pay is account-type agnostic: Stripe direct charges use the
    // platform key + Stripe-Account header for Standard and Express alike,
    // and card_payments (encoded in charges_enabled) is the only capability
    // requirement. Guard against anyone gating this route on account_type.
    getStripeConnectAccountMock.mockResolvedValue({
      stripe_account_id: "acct_standard_seller",
      onboarding_complete: true,
      charges_enabled: true,
      payouts_enabled: true,
      tax_enabled: false,
      account_type: "standard",
    });

    const res = await callHandler();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ secret: "pst_test" });
    expect(connectionTokensCreate).toHaveBeenCalledWith(
      {},
      { stripeAccount: "acct_standard_seller" }
    );
  });

  it("does not touch Terminal when Stripe isn't connected", async () => {
    getStripeConnectAccountMock.mockResolvedValue(null);

    const res = await callHandler();

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe("stripe_not_connected");
    expect(ensureTerminalLocationMock).not.toHaveBeenCalled();
    expect(connectionTokensCreate).not.toHaveBeenCalled();
  });
});
