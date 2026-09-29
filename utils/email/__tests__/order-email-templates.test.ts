import {
  orderConfirmationEmail,
  sellerNewOrderEmail,
} from "../email-templates";

// The order-email route forwards untyped request-body JSON into these
// templates. esc() used to call .replace on any truthy value, so a numeric
// amount (or an object-shaped field) threw "x.replace is not a function" and
// BOTH buyer and seller order emails were dropped. These pin the coercion.

const base = {
  orderId: "order-1234567890abcdef",
  productTitle: "Raw Milk",
  amount: "21",
  currency: "USD",
  paymentMethod: "Card",
};

describe("order email templates with untyped request data", () => {
  it("coerces numeric scalars instead of crashing", () => {
    const params = {
      ...base,
      amount: 21 as unknown as string,
      selectedBulkOption: 3 as unknown as string,
      subscriptionFrequency: "weekly",
    };
    const buyer = orderConfirmationEmail(params);
    expect(buyer.subject).toContain("Raw Milk");
    expect(buyer.html).toContain("21");
    expect(buyer.html).toContain("3");
    const seller = sellerNewOrderEmail(params);
    expect(seller.html).toContain("21");
  });

  it("drops object/array fields rather than throwing", () => {
    const params = {
      ...base,
      buyerName: { first: "Ada" } as unknown as string,
      shippingAddress: ["123 Farm Rd"] as unknown as string,
    };
    expect(() => orderConfirmationEmail(params)).not.toThrow();
    expect(() => sellerNewOrderEmail(params)).not.toThrow();
    const { html } = orderConfirmationEmail(params);
    expect(html).toContain("Hi there,");
    expect(html).not.toContain("[object Object]");
  });

  it("still renders numeric contact info as text", () => {
    const { html } = sellerNewOrderEmail({
      ...base,
      buyerContact: 12345 as unknown as string,
    });
    expect(html).toContain("12345");
  });

  it("keeps escaping real strings", () => {
    const { html } = orderConfirmationEmail({
      ...base,
      buyerName: "<script>alert(1)</script>",
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});
