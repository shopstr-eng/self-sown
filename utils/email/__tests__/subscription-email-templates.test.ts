import {
  subscriptionConfirmationEmail,
  renewalReminderEmail,
  subscriptionIdRecoveryEmail,
} from "../email-templates";

// The guest subscription lookup (GET /api/stripe/get-subscriptions?email=…)
// requires the Stripe subscription ID as an unguessable capability. These pin
// that the ID actually reaches the buyer's mailbox: confirmation and renewal
// emails must render the full ID, and the recovery email must list it.

const params = {
  productTitle: "Raw Milk",
  frequency: "weekly",
  discountPercent: 10,
  regularPrice: "10",
  subscriptionPrice: "9",
  currency: "USD",
  nextBillingDate: "November 1, 2026",
  subscriptionId: "sub_secret_1N23",
};

describe("buyer-facing subscription emails carry the full subscription ID", () => {
  it("subscription confirmation includes the full ID", () => {
    const { html } = subscriptionConfirmationEmail(params);
    expect(html).toContain("sub_secret_1N23");
    expect(html).toContain("Subscription ID");
  });

  it("renewal reminder includes the full ID", () => {
    const { html } = renewalReminderEmail(params);
    expect(html).toContain("sub_secret_1N23");
  });

  it("omits the ID row entirely when no ID is provided", () => {
    const { subscriptionId: _subscriptionId, ...noId } = params;
    const { html } = subscriptionConfirmationEmail(noId);
    expect(html).not.toContain("Subscription ID");
  });

  it("escapes a hostile ID rather than injecting markup", () => {
    const { html } = subscriptionConfirmationEmail({
      ...params,
      subscriptionId: '"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>");
  });
});

describe("subscription ID recovery email", () => {
  it("lists every subscription ID with its product", () => {
    const { subject, html } = subscriptionIdRecoveryEmail({
      subscriptions: [
        { subscriptionId: "sub_secret_1N23", productTitle: "Raw Milk" },
        { subscriptionId: "sub_other_9Z", productTitle: "Cheddar" },
      ],
    });
    expect(subject).toContain("IDs");
    expect(html).toContain("sub_secret_1N23");
    expect(html).toContain("sub_other_9Z");
    expect(html).toContain("Raw Milk");
    expect(html).toContain("Cheddar");
  });
});
