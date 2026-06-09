import { proLifetimeLingeringCancelAlertEmail } from "@/utils/email/email-templates";

const send = jest.fn();
const getUncachableSendGridClient = jest.fn();

jest.mock("@/utils/email/sendgrid-client", () => ({
  getUncachableSendGridClient: () => getUncachableSendGridClient(),
}));

// Import after the mock is registered so email-service picks up the stub.
import { sendProLifetimeLingeringCancelAlert } from "@/utils/email/email-service";

describe("sendProLifetimeLingeringCancelAlert recipient resolution", () => {
  const base = {
    pubkey: "abc123pubkey",
    subscriptionId: "sub_lingering_1",
    source: "purchase" as const,
    error: "stripe down",
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
    const result = await sendProLifetimeLingeringCancelAlert({
      ...base,
      adminEmail: "admin@milk.market",
    });

    expect(result).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("admin@milk.market");
  });

  it("falls back to the SendGrid from_email when no adminEmail is given", async () => {
    const result = await sendProLifetimeLingeringCancelAlert(base);

    expect(result).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("operator@milk.market");
  });

  it("trims an explicit adminEmail before using it", async () => {
    const result = await sendProLifetimeLingeringCancelAlert({
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

    const result = await sendProLifetimeLingeringCancelAlert(base);

    expect(result).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns false without throwing when no recipient can be resolved", async () => {
    getUncachableSendGridClient.mockResolvedValue({
      client: { send },
      fromEmail: "",
    });

    const result = await sendProLifetimeLingeringCancelAlert(base);

    expect(result).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("proLifetimeLingeringCancelAlertEmail", () => {
  const base = {
    pubkey: "abc123pubkey",
    subscriptionId: "sub_lingering_1",
    source: "purchase" as const,
    error: "stripe API timeout",
  };

  it("renders the pubkey, subscriptionId, source label, and error", () => {
    const { subject, html } = proLifetimeLingeringCancelAlertEmail(base);

    expect(html).toContain("abc123pubkey");
    expect(html).toContain("sub_lingering_1");
    expect(html).toContain("At-purchase cancellation");
    expect(html).toContain("stripe API timeout");
    expect(subject).toContain("Stuck lifetime-member subscription");
  });

  it("labels the renewal_webhook source as the auto-retry path", () => {
    const { html } = proLifetimeLingeringCancelAlertEmail({
      ...base,
      source: "renewal_webhook",
    });

    expect(html).toContain("Renewal webhook auto-retry");
  });

  it("escapes HTML in the error so the alert can't be broken by it", () => {
    const { html } = proLifetimeLingeringCancelAlertEmail({
      ...base,
      error: "<script>alert(1)</script>",
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
