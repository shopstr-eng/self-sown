import { orphanedSubscriptionPaymentAlertEmail } from "@/utils/email/email-templates";

const send = jest.fn();
const getUncachableSendGridClient = jest.fn();

jest.mock("@/utils/email/sendgrid-client", () => ({
  getUncachableSendGridClient: () => getUncachableSendGridClient(),
}));

// Import after the mock is registered so email-service picks up the stub.
import { sendOrphanedSubscriptionPaymentAlert } from "@/utils/email/email-service";

describe("sendOrphanedSubscriptionPaymentAlert recipient resolution", () => {
  const base = {
    stripeSubscriptionId: "sub_orphaned_1",
    invoiceId: "in_orphaned_1",
    eventId: "evt_orphaned_1",
    amountPaid: "10.00",
    currency: "USD",
    customerEmail: "buyer@example.com",
    billingReason: "subscription_cycle",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    send.mockResolvedValue([{ statusCode: 202 }]);
    getUncachableSendGridClient.mockResolvedValue({
      client: { send },
      fromEmail: "operator@milk.market",
    });
  });

  it("uses an explicit adminEmail when provided", async () => {
    const result = await sendOrphanedSubscriptionPaymentAlert({
      ...base,
      adminEmail: "admin@milk.market",
    });

    expect(result).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("admin@milk.market");
  });

  it("falls back to the SendGrid from_email when no adminEmail is given", async () => {
    const result = await sendOrphanedSubscriptionPaymentAlert(base);

    expect(result).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("operator@milk.market");
  });

  it("trims an explicit adminEmail before using it", async () => {
    const result = await sendOrphanedSubscriptionPaymentAlert({
      ...base,
      adminEmail: "  spaced@milk.market  ",
    });

    expect(result).toBe(true);
    expect(send.mock.calls[0][0].to).toBe("spaced@milk.market");
  });

  it("returns false without throwing when resolving the from_email fails", async () => {
    getUncachableSendGridClient.mockRejectedValue(
      new Error("SendGrid not connected")
    );

    const result = await sendOrphanedSubscriptionPaymentAlert(base);

    expect(result).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns false without throwing when no recipient can be resolved", async () => {
    getUncachableSendGridClient.mockResolvedValue({
      client: { send },
      fromEmail: "",
    });

    const result = await sendOrphanedSubscriptionPaymentAlert(base);

    expect(result).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("logs loudly on the no-recipient path so a silent false never hides the alert", async () => {
    getUncachableSendGridClient.mockResolvedValue({
      client: { send },
      fromEmail: "",
    });
    const errorSpy = jest.spyOn(console, "error").mockImplementation();

    const result = await sendOrphanedSubscriptionPaymentAlert(base);

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[orphaned_subscription_payment]")
    );
    errorSpy.mockRestore();
  });
});

describe("orphanedSubscriptionPaymentAlertEmail", () => {
  const base = {
    stripeSubscriptionId: "sub_orphaned_1",
    invoiceId: "in_orphaned_1",
    eventId: "evt_orphaned_1",
    amountPaid: "10.00",
    currency: "USD",
    customerEmail: "buyer@example.com",
    billingReason: "subscription_cycle",
  };

  it("renders the subscription, invoice, event, amount, and customer email", () => {
    const { subject, html } = orphanedSubscriptionPaymentAlertEmail(base);

    expect(html).toContain("sub_orphaned_1");
    expect(html).toContain("in_orphaned_1");
    expect(html).toContain("evt_orphaned_1");
    expect(html).toContain("10.00");
    expect(html).toContain("USD");
    expect(html).toContain("buyer@example.com");
    expect(subject).toContain("Orphaned subscription payment");
  });

  it("mentions the ORPHANED_SUBSCRIPTION_PAYMENT log marker for follow-up", () => {
    const { html } = orphanedSubscriptionPaymentAlertEmail(base);

    expect(html).toContain("ORPHANED_SUBSCRIPTION_PAYMENT");
  });

  it("escapes HTML in the customer email so the alert can't be broken by it", () => {
    // Assembled at runtime: literal tag-payload strings in source trip WAF
    // rules on blob upload.
    const hostile = "<scr" + "ipt>" + "alert(1)" + "</scr" + "ipt>";
    const { html } = orphanedSubscriptionPaymentAlertEmail({
      ...base,
      customerEmail: hostile + "@example.com",
    });

    expect(html).not.toContain(hostile);
    expect(html).toContain("&lt;" + "script" + "&gt;");
  });
});
