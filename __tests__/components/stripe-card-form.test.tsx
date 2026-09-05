/** @jest-environment jsdom */

// StripeCardForm wallet support: the ExpressCheckoutElement (Apple Pay /
// Google Pay / Link, device-detected by Stripe) must render alongside the
// PaymentElement with in-tab wallets disabled (no duplicate wallet UI), and
// both the express onConfirm and the card submit must drive the same
// confirmPayment flow with the same success/error callbacks.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import StripeCardForm from "@/components/utility-components/stripe-card-form";

const confirmPaymentMock = jest.fn();
let expressOnConfirm: (() => Promise<void>) | undefined;
let expressOnClick:
  | ((event: { resolve: () => void; reject: () => void }) => void)
  | undefined;
let paymentElementOptions: any;

jest.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: any) => <>{children}</>,
  PaymentElement: (props: any) => {
    paymentElementOptions = props.options;
    return <div data-testid="payment-element" />;
  },
  ExpressCheckoutElement: (props: any) => {
    expressOnConfirm = props.onConfirm;
    expressOnClick = props.onClick;
    return <div data-testid="express-checkout" />;
  },
  useStripe: () => ({ confirmPayment: confirmPaymentMock }),
  useElements: () => ({}),
}));

jest.mock("@stripe/stripe-js", () => ({
  loadStripe: jest.fn(async () => ({ fakeStripe: true })),
}));

function renderForm(overrides: Record<string, unknown> = {}) {
  return render(
    <StripeCardForm
      clientSecret="pi_test_secret"
      onPaymentSuccess={jest.fn()}
      onPaymentError={jest.fn()}
      onCancel={jest.fn()}
      {...overrides}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  expressOnConfirm = undefined;
  expressOnClick = undefined;
  paymentElementOptions = undefined;
  confirmPaymentMock.mockResolvedValue({
    paymentIntent: { id: "pi_123", status: "succeeded" },
  });
});

describe("StripeCardForm wallet checkout", () => {
  it("renders the express checkout element and keeps wallets out of the payment tabs", async () => {
    renderForm();
    expect(await screen.findByTestId("express-checkout")).toBeTruthy();
    expect(await screen.findByTestId("payment-element")).toBeTruthy();
    expect(paymentElementOptions.wallets).toEqual({
      applePay: "never",
      googlePay: "never",
    });
  });

  it("wallet confirm runs the shared confirmPayment flow and reports success", async () => {
    const onPaymentSuccess = jest.fn();
    renderForm({ onPaymentSuccess });
    await screen.findByTestId("express-checkout");
    expect(expressOnConfirm).toBeDefined();

    await expressOnConfirm!();

    expect(confirmPaymentMock).toHaveBeenCalledWith(
      expect.objectContaining({ redirect: "if_required" })
    );
    expect(onPaymentSuccess).toHaveBeenCalledWith("pi_123");
  });

  it("card submit and wallet confirm share the same confirm path", async () => {
    const onPaymentSuccess = jest.fn();
    renderForm({ onPaymentSuccess });
    await screen.findByTestId("payment-element");

    fireEvent.click(screen.getByText("Pay now"));

    await waitFor(() =>
      expect(onPaymentSuccess).toHaveBeenCalledWith("pi_123")
    );
    expect(confirmPaymentMock).toHaveBeenCalledTimes(1);
  });

  it("blocks a second confirm while one is in flight (card + wallet race)", async () => {
    let resolveConfirm: ((v: any) => void) | undefined;
    confirmPaymentMock.mockReturnValue(
      new Promise((resolve) => {
        resolveConfirm = resolve;
      })
    );
    renderForm();
    await screen.findByTestId("express-checkout");

    const first = expressOnConfirm!();
    const second = expressOnConfirm!();
    resolveConfirm!({ paymentIntent: { id: "pi_123", status: "succeeded" } });
    await Promise.all([first, second]);

    expect(confirmPaymentMock).toHaveBeenCalledTimes(1);
  });

  it("rejects wallet sheet clicks while a payment is already in flight", async () => {
    confirmPaymentMock.mockReturnValue(new Promise(() => {}));
    renderForm();
    await screen.findByTestId("express-checkout");

    const resolve = jest.fn();
    const reject = jest.fn();
    expressOnClick!({ resolve, reject });
    expect(resolve).toHaveBeenCalledTimes(1);

    void expressOnConfirm!(); // now locked (pending confirm)

    resolve.mockClear();
    expressOnClick!({ resolve, reject });
    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledTimes(1);
  });

  it("surfaces wallet confirm failures through onPaymentError", async () => {
    confirmPaymentMock.mockResolvedValue({
      error: { message: "card declined" },
    });
    const onPaymentError = jest.fn();
    renderForm({ onPaymentError });
    await screen.findByTestId("express-checkout");

    await expressOnConfirm!();

    expect(onPaymentError).toHaveBeenCalledWith("card declined");
    expect(await screen.findByText("card declined")).toBeTruthy();
  });
});
