const BRAND_NAME = "Milk Market";

function baseTemplate(title: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background-color:#000000;padding:24px 32px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">${BRAND_NAME}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              ${bodyContent}
            </td>
          </tr>
          <tr>
            <td style="background-color:#f9fafb;padding:20px 32px;text-align:center;border-top:1px solid #e5e7eb;">
              <p style="margin:0;color:#9ca3af;font-size:12px;">This email was sent by ${BRAND_NAME}. You received this because an order was placed with your email address.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildProductDescriptors(params: {
  selectedSize?: string;
  selectedVolume?: string;
  selectedWeight?: string;
  selectedBulkOption?: string;
}): string {
  const descriptors: string[] = [];
  if (params.selectedSize) descriptors.push(`Size: ${params.selectedSize}`);
  if (params.selectedVolume)
    descriptors.push(`Volume: ${params.selectedVolume}`);
  if (params.selectedWeight)
    descriptors.push(`Weight: ${params.selectedWeight}`);
  if (params.selectedBulkOption)
    descriptors.push(`Bundle: ${params.selectedBulkOption} units`);
  if (descriptors.length === 0) return "";
  return `<tr>
        <td style="padding:16px 0;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">Product Details</p>
          <p style="margin:0;color:#111827;font-size:15px;">${descriptors.join(
            " &bull; "
          )}</p>
        </td>
      </tr>`;
}

function buildDeliverySection(params: {
  shippingAddress?: string;
  pickupLocation?: string;
}): string {
  const rows: string[] = [];
  if (params.shippingAddress) {
    rows.push(`<tr>
        <td style="padding:16px 0;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">Shipping Address</p>
          <p style="margin:0;color:#111827;font-size:15px;">${params.shippingAddress}</p>
        </td>
      </tr>`);
  }
  if (params.pickupLocation) {
    rows.push(`<tr>
        <td style="padding:16px 0;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">Pickup Location</p>
          <p style="margin:0;color:#111827;font-size:15px;">${params.pickupLocation}</p>
        </td>
      </tr>`);
  }
  return rows.join("");
}

export interface OrderEmailParams {
  orderId: string;
  productTitle: string;
  amount: string;
  currency: string;
  paymentMethod: string;
  buyerName?: string;
  shippingAddress?: string;
  pickupLocation?: string;
  selectedSize?: string;
  selectedVolume?: string;
  selectedWeight?: string;
  selectedBulkOption?: string;
  buyerContact?: string;
}

export function orderConfirmationEmail(params: OrderEmailParams): {
  subject: string;
  html: string;
} {
  const greeting = params.buyerName ? `Hi ${params.buyerName},` : "Hi there,";

  const deliverySection = buildDeliverySection(params);
  const descriptorsSection = buildProductDescriptors(params);

  const body = `
    <h2 style="margin:0 0 16px;color:#111827;font-size:20px;">${greeting}</h2>
    <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">Your order has been confirmed! Here are the details:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;padding:20px;margin-bottom:24px;">
      <tr>
        <td style="padding:8px 0;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">Order ID</p>
          <p style="margin:0;color:#111827;font-size:15px;font-family:monospace;">${params.orderId}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 0;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">Product</p>
          <p style="margin:0;color:#111827;font-size:15px;">${params.productTitle}</p>
        </td>
      </tr>
      ${descriptorsSection}
      <tr>
        <td style="padding:16px 0;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">Amount</p>
          <p style="margin:0;color:#111827;font-size:18px;font-weight:600;">${params.amount} ${params.currency}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 0;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">Payment Method</p>
          <p style="margin:0;color:#111827;font-size:15px;">${params.paymentMethod}</p>
        </td>
      </tr>
      ${deliverySection}
    </table>
    <p style="margin:0;color:#374151;font-size:15px;line-height:1.6;">The seller has been notified and you'll receive updates about your order via email.</p>`;

  return {
    subject: `Order Confirmed - ${params.productTitle} (#${params.orderId.slice(
      0,
      8
    )})`,
    html: baseTemplate("Order Confirmation", body),
  };
}

export function sellerNewOrderEmail(params: OrderEmailParams): {
  subject: string;
  html: string;
} {
  const buyerInfo = params.buyerName || params.buyerContact || "A buyer";

  const deliverySection = buildDeliverySection(params);
  const descriptorsSection = buildProductDescriptors(params);

  const buyerContactSection = params.buyerContact
    ? `<tr>
        <td style="padding:16px 0;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">Buyer Contact</p>
          <p style="margin:0;color:#111827;font-size:15px;">${params.buyerContact}</p>
        </td>
      </tr>`
    : "";

  const body = `
    <h2 style="margin:0 0 16px;color:#111827;font-size:20px;">New Order Received!</h2>
    <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">${buyerInfo} has placed an order for your product.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;padding:20px;margin-bottom:24px;">
      <tr>
        <td style="padding:8px 0;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">Order ID</p>
          <p style="margin:0;color:#111827;font-size:15px;font-family:monospace;">${params.orderId}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 0;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">Product</p>
          <p style="margin:0;color:#111827;font-size:15px;">${params.productTitle}</p>
        </td>
      </tr>
      ${descriptorsSection}
      <tr>
        <td style="padding:16px 0;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">Amount</p>
          <p style="margin:0;color:#111827;font-size:18px;font-weight:600;">${params.amount} ${params.currency}</p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 0;border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;">Payment Method</p>
          <p style="margin:0;color:#111827;font-size:15px;">${params.paymentMethod}</p>
        </td>
      </tr>
      ${deliverySection}
      ${buyerContactSection}
    </table>
    <p style="margin:0;color:#374151;font-size:15px;line-height:1.6;">Please check your Milk Market orders dashboard for full details and to manage this order.</p>`;

  return {
    subject: `New Order - ${params.productTitle} (#${params.orderId.slice(
      0,
      8
    )})`,
    html: baseTemplate("New Order", body),
  };
}

export function orderUpdateEmail(params: {
  orderId: string;
  productTitle: string;
  updateType: "shipping" | "status" | "message";
  message: string;
  trackingNumber?: string;
  carrier?: string;
  estimatedDelivery?: string;
}): { subject: string; html: string } {
  let updateTitle = "Order Update";
  let subjectLine = `Order Update - ${params.productTitle}`;

  if (params.updateType === "shipping") {
    updateTitle = "Shipping Update";
    subjectLine = `Shipped - ${params.productTitle} (#${params.orderId.slice(
      0,
      8
    )})`;
  } else if (params.updateType === "status") {
    updateTitle = "Order Status Update";
    subjectLine = `Status Update - ${
      params.productTitle
    } (#${params.orderId.slice(0, 8)})`;
  }

  const trackingSection =
    params.trackingNumber && params.carrier
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:20px;margin:24px 0;">
        <tr>
          <td>
            <p style="margin:0 0 8px;color:#166534;font-size:14px;font-weight:600;">Tracking Information</p>
            <p style="margin:0 0 4px;color:#374151;font-size:14px;"><strong>Carrier:</strong> ${
              params.carrier
            }</p>
            <p style="margin:0 0 4px;color:#374151;font-size:14px;"><strong>Tracking #:</strong> ${
              params.trackingNumber
            }</p>
            ${
              params.estimatedDelivery
                ? `<p style="margin:0;color:#374151;font-size:14px;"><strong>Est. Delivery:</strong> ${params.estimatedDelivery}</p>`
                : ""
            }
          </td>
        </tr>
      </table>`
      : "";

  const body = `
    <h2 style="margin:0 0 16px;color:#111827;font-size:20px;">${updateTitle}</h2>
    <p style="margin:0 0 8px;color:#6b7280;font-size:13px;">Order #${params.orderId.slice(
      0,
      8
    )} &bull; ${params.productTitle}</p>
    <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">${
      params.message
    }</p>
    ${trackingSection}
    <p style="margin:24px 0 0;color:#374151;font-size:15px;line-height:1.6;">Check your Milk Market orders page for more details.</p>`;

  return {
    subject: subjectLine,
    html: baseTemplate(updateTitle, body),
  };
}
