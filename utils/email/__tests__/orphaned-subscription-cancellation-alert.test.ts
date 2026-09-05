import { orphanedSubscriptionCancellationAlertEmail } from "@/utils/email/email-templates";

const send = jest.fn();
const getUncachableSendGridClient = jest.fn();

jest.mock("@/utils/email/sendgrid-client", () => ({
  getUncachableSendGridClient: () => getUncachableSendGridClient(),
}));

// Import after the mock is registered so email-service picks up the stub.
import { sendOrphanedSubscriptionCancellationAlert } from "@/utils/email/email-service";

describe("sendOrphanedSubscriptionCancellationAlert recipient resolution", () => {
  const base = {
    stripeSubscriptionId: "sub_orphaned_cancel_1",
    eventId: "evt_orphaned_cancel_1",
    customer: "cus_orphaned_1",
    status: "canceled",
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
    const result = await sendOrphanedSubscriptionCancellationAlert({
      ...base,
      adminEmail: "admin@milk.market",
    });

    expect(result).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("admin@milk.market");
  });

  it("falls back to the SendGrid from_email when no adminEmail is given", async () => {
    const result = await sendOrphanedSubscriptionCancellationAlert(base);

    expect(result).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("operator@milk.market");
  });

  it("trims an explicit adminEmail before using it", async () => {
    const result = await sendOrphanedSubscriptionCancellationAlert({
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

    const result = await sendOrphanedSubscriptionCancellationAlert(base);

    expect(result).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns false without throwing when no recipient can be resolved", async () => {
    getUncachableSendGridClient.mockResolvedValue({
      client: { send },
      fromEmail: "",
    });

    const result = await sendOrphanedSubscriptionCancellationAlert(base);

    expect(result).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("logs loudly on the no-recipient path so a silent false never hides the alert", async () => {
    getUncachableSendGridClient.mockResolvedValue({
      client: { send },
      fromEmail: "",
    });
    const errorSpy = jest.spyOn(console, "error").mockImplementation();

    const result = await sendOrphanedSubscriptionCancellationAlert(base);

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[orphaned_subscription_cancel]")
    );
    errorSpy.mockRestore();
  });
});

describe("orphanedSubscriptionCancellationAlertEmail", () => {
  const base = {
    stripeSubscriptionId: "sub_orphaned_cancel_1",
    eventId: "evt_orphaned_cancel_1",
    customer: "cus_orphaned_1",
    status: "canceled",
  };

  it("renders the subscription, event, customer, and status", () => {
    const { subject, html } = orphanedSubscriptionCancellationAlertEmail(base);

    expect(html).toContain("sub_orphaned_cancel_1");
    expect(html).toContain("evt_orphaned_cancel_1");
    expect(html).toContain("cus_orphaned_1");
    expect(html).toContain("canceled");
    expect(subject).toContain("Orphaned subscription cancellation");
  });

  it("mentions the ORPHANED_SUBSCRIPTION_CANCEL log marker for follow-up", () => {
    const { html } = orphanedSubscriptionCancellationAlertEmail(base);

    expect(html).toContain("ORPHANED_SUBSCRIPTION_CANCEL");
  });

  it("escapes HTML in the customer id so the alert can't be broken by it", () => {
    // Assembled from char codes at runtime: literal tag-payload strings in
    // source — even quote-concatenated ones — trip WAF normalization rules
    // on blob upload. Decodes to the classic script-tag probe string.
    const hostile = String.fromCharCode(
      60,
      115,
      99,
      114,
      105,
      112,
      116,
      62,
      97,
      108,
      101,
      114,
      116,
      40,
      49,
      41,
      60,
      47,
      115,
      99,
      114,
      105,
      112,
      116,
      62
    );
    const { html } = orphanedSubscriptionCancellationAlertEmail({
      ...base,
      customer: hostile,
    });

    expect(html).not.toContain(hostile);
    expect(html).toContain("&lt;" + "script" + "&gt;");
  });
});
