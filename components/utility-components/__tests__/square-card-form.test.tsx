/** @jest-environment jsdom */

// jsdom coverage for the Square checkout form's Apple Pay path (parity with
// Stripe's payment-request button):
//
//   1. With a countryCode on a FIAT cart, a payment request is built with the
//      merchant's country/currency; payments.applePay() resolving means the
//      device + verified domain support Apple Pay, so OUR button renders
//      (Square's SDK has no attach() for Apple Pay).
//   2. Clicking it tokenizes and charges through the same
//      /api/square/create-payment endpoint as the card form (sourceId is a
//      nonce either way).
//   3. The payment-request total uses the currency's real fraction digits
//      (JPY: no decimals).
//   4. When Apple Pay is unavailable (payments.applePay throws) no button
//      renders and a keyed-in card still charges.
//   5. Without a countryCode (legacy connection, backfill pending) Apple Pay
//      is never probed.
//   6. Crypto (sats) carts never probe Apple Pay: the server converts sats to
//      fiat at charge time with a live FX quote, so a client-built wallet
//      total couldn't be guaranteed to match the charge.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SquareCardForm from "@/components/utility-components/square-card-form";

const PUBKEY = "c".repeat(64);

const cardMock = {
  attach: jest.fn().mockResolvedValue(undefined),
  tokenize: jest.fn().mockResolvedValue({ status: "OK", token: "cnon:card" }),
  destroy: jest.fn().mockResolvedValue(undefined),
};
// NOTE: no attach — the real Square ApplePay class doesn't have one.
const applePayMock = {
  tokenize: jest
    .fn()
    .mockResolvedValue({ status: "OK", token: "cnon:applepay" }),
  destroy: jest.fn().mockResolvedValue(undefined),
};
const paymentRequestMock = jest.fn((req: unknown) => req);
const paymentsMock = {
  card: jest.fn().mockResolvedValue(cardMock),
  paymentRequest: paymentRequestMock,
  applePay: jest.fn().mockResolvedValue(applePayMock),
};
const fetchMock = jest.fn();

type FormProps = Parameters<typeof SquareCardForm>[0];

function renderForm(overrides: Partial<FormProps> = {}) {
  const props: FormProps = {
    applicationId: "sandbox-sq0idb-appid",
    locationId: "loc-1",
    environment: "sandbox",
    countryCode: "US",
    sellerPubkey: PUBKEY,
    amount: 25,
    currency: "USD",
    productTitle: "Test Product",
    customerEmail: "buyer@example.com",
    metadata: { orderId: "ord1" },
    onPaymentSuccess: jest.fn(),
    onPaymentError: jest.fn(),
    onCancel: jest.fn(),
    ...overrides,
  };
  return { ...render(<SquareCardForm {...props} />), props };
}

beforeEach(() => {
  jest.clearAllMocks();
  (window as unknown as { Square: unknown }).Square = {
    payments: jest.fn().mockReturnValue(paymentsMock),
  };
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, paymentId: "sqpay-1" }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  delete (window as unknown as { Square?: unknown }).Square;
});

describe("SquareCardForm Apple Pay", () => {
  it("builds the payment request with merchant country/currency and renders our button once Apple Pay resolves", async () => {
    renderForm();
    await waitFor(() => expect(cardMock.attach).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^pay with apple pay$/i })
      ).toBeTruthy()
    );
    expect(paymentRequestMock).toHaveBeenCalledWith({
      countryCode: "US",
      currencyCode: "USD",
      total: { amount: "25.00", label: "Test Product" },
    });
  });

  it("clicking the Apple Pay button tokenizes and charges via the shared endpoint", async () => {
    const { props } = renderForm();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^pay with apple pay$/i })
      ).toBeTruthy()
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^pay with apple pay$/i })
    );
    await waitFor(() =>
      expect(props.onPaymentSuccess).toHaveBeenCalledWith("sqpay-1")
    );
    expect(applePayMock.tokenize).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/square/create-payment",
      expect.objectContaining({
        body: expect.stringContaining('"sourceId":"cnon:applepay"'),
      })
    );
    // Card nonce must not have been used.
    expect(cardMock.tokenize).not.toHaveBeenCalled();
  });

  it("formats the total with the currency's fraction digits (JPY: none)", async () => {
    renderForm({ currency: "JPY", amount: 100 });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^pay with apple pay$/i })
      ).toBeTruthy()
    );
    expect(paymentRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currencyCode: "JPY",
        total: { amount: "100", label: "Test Product" },
      })
    );
  });

  it("ceils fractional totals to minor units so the wallet total matches the server charge", async () => {
    // The server charges Math.ceil(amount) minor units for zero-decimal
    // currencies; a toNearest wallet total would under-display the charge.
    renderForm({ currency: "JPY", amount: 99.4 });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^pay with apple pay$/i })
      ).toBeTruthy()
    );
    expect(paymentRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        total: { amount: "100", label: "Test Product" },
      })
    );
  });

  it("hides the button if reinitialization fails after a prop change", async () => {
    const { rerender, props } = renderForm();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^pay with apple pay$/i })
      ).toBeTruthy()
    );
    paymentsMock.applePay.mockRejectedValueOnce(new Error("now unavailable"));
    // Amount change tears down the effect and re-runs it against a now-failing
    // applePay(); the stale button must disappear.
    rerender(<SquareCardForm {...props} amount={30} />);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^pay with apple pay$/i })
      ).toBeNull()
    );
  });

  it("renders no Apple Pay button and keeps card entry when Apple Pay is unavailable", async () => {
    paymentsMock.applePay.mockRejectedValueOnce(
      new Error("Apple Pay is not available on this device")
    );
    const { container, props } = renderForm();
    await waitFor(() => expect(cardMock.attach).toHaveBeenCalled());
    await waitFor(() => expect(paymentsMock.applePay).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /^pay with apple pay$/i })
    ).toBeNull();

    fireEvent.submit(container.querySelector("form") as Element);
    await waitFor(() =>
      expect(props.onPaymentSuccess).toHaveBeenCalledWith("sqpay-1")
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/square/create-payment",
      expect.objectContaining({
        body: expect.stringContaining('"sourceId":"cnon:card"'),
      })
    );
  });

  it("charges a keyed-in card through the same endpoint", async () => {
    const { container, props } = renderForm();
    await waitFor(() => expect(cardMock.attach).toHaveBeenCalled());
    fireEvent.submit(container.querySelector("form") as Element);
    await waitFor(() =>
      expect(props.onPaymentSuccess).toHaveBeenCalledWith("sqpay-1")
    );
    expect(cardMock.tokenize).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/square/create-payment",
      expect.objectContaining({
        body: expect.stringContaining('"sourceId":"cnon:card"'),
      })
    );
  });

  it("never probes Apple Pay without a countryCode", async () => {
    renderForm({ countryCode: undefined });
    await waitFor(() => expect(cardMock.attach).toHaveBeenCalled());
    expect(paymentsMock.applePay).not.toHaveBeenCalled();
    expect(paymentRequestMock).not.toHaveBeenCalled();
  });

  it("never probes Apple Pay for crypto-denominated carts (sats)", async () => {
    renderForm({ currency: "sats", amount: 25000 });
    await waitFor(() => expect(cardMock.attach).toHaveBeenCalled());
    expect(paymentsMock.applePay).not.toHaveBeenCalled();
    expect(paymentRequestMock).not.toHaveBeenCalled();
  });
});
