import { getUncachableSendGridClient } from "./sendgrid-client";
import {
  orderConfirmationEmail,
  sellerNewOrderEmail,
  orderUpdateEmail,
  OrderEmailParams,
} from "./email-templates";

async function sendEmail(
  to: string,
  subject: string,
  html: string
): Promise<boolean> {
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    await client.send({
      to,
      from: fromEmail,
      subject,
      html,
    });
    return true;
  } catch (error) {
    console.error("Failed to send email:", error);
    return false;
  }
}

export async function sendOrderConfirmationToBuyer(
  buyerEmail: string,
  params: OrderEmailParams
): Promise<boolean> {
  const { subject, html } = orderConfirmationEmail(params);
  return sendEmail(buyerEmail, subject, html);
}

export async function sendNewOrderToSeller(
  sellerEmail: string,
  params: OrderEmailParams
): Promise<boolean> {
  const { subject, html } = sellerNewOrderEmail(params);
  return sendEmail(sellerEmail, subject, html);
}

export async function sendOrderUpdateToBuyer(
  buyerEmail: string,
  params: {
    orderId: string;
    productTitle: string;
    updateType: "shipping" | "status" | "message";
    message: string;
    trackingNumber?: string;
    carrier?: string;
    estimatedDelivery?: string;
  }
): Promise<boolean> {
  const { subject, html } = orderUpdateEmail(params);
  return sendEmail(buyerEmail, subject, html);
}
