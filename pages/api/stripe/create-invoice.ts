import type { NextApiRequest, NextApiResponse } from "next";
import Stripe from "stripe";
import { fiat } from "@getalby/lightning-tools";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-12-18.acacia",
});

// Convert satoshis to USD using Getalby Lightning Tools
const satsToUSD = async (sats: number): Promise<number> => {
  try {
    const usdAmount = await fiat.convertSatsToFiat(sats, "USD");
    return usdAmount;
  } catch (error) {
    console.error("Error converting sats to USD:", error);
    // Fallback to approximate rate if conversion fails
    const btcPrice = 100000;
    return (sats / 100000000) * btcPrice;
  }
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      amount,
      currency,
      customerEmail,
      productTitle,
      productDescription,
      shippingInfo,
      metadata,
    } = req.body;

    // Convert amount to USD cents
    let amountInCents: number;
    const currencyLower = currency.toLowerCase();

    if (currencyLower === "sats" || currencyLower === "sat") {
      // Convert sats to USD
      const usdAmount = await satsToUSD(amount);
      amountInCents = Math.round(usdAmount * 100);
    } else if (currencyLower === "btc") {
      // Convert BTC to sats, then to USD
      const sats = amount * 100000000;
      const usdAmount = await satsToUSD(sats);
      amountInCents = Math.round(usdAmount * 100);
    } else if (currencyLower === "usd") {
      // Already in USD, just convert to cents
      amountInCents = Math.round(amount * 100);
    } else {
      // For other fiat currencies, amount is already in that currency
      // Stripe will handle the conversion, just convert to cents
      amountInCents = Math.round(amount * 100);
    }

    // Create or retrieve customer
    let customer;
    if (customerEmail) {
      const existingCustomers = await stripe.customers.list({
        email: customerEmail,
        limit: 1,
      });

      if (existingCustomers.data.length > 0) {
        customer = existingCustomers.data[0];
      } else {
        customer = await stripe.customers.create({
          email: customerEmail,
          ...(shippingInfo && {
            shipping: {
              name: shippingInfo.name,
              address: {
                line1: shippingInfo.address,
                line2: shippingInfo.unit || undefined,
                city: shippingInfo.city,
                state: shippingInfo.state,
                postal_code: shippingInfo.postalCode,
                country: shippingInfo.country,
              },
            },
          }),
        });
      }
    }

    // Create invoice
    const invoice = await stripe.invoices.create({
      customer: customer?.id,
      collection_method: "send_invoice",
      days_until_due: 1,
      metadata: {
        ...metadata,
        originalAmount: amount.toString(),
        originalCurrency: currency,
      },
    });

    // Add invoice item
    // Always use USD for Stripe invoices since we convert everything to USD
    await stripe.invoiceItems.create({
      customer: customer?.id,
      invoice: invoice.id,
      amount: amountInCents,
      currency: "usd",
      description: `${productTitle}${
        productDescription ? ` - ${productDescription}` : ""
      }`,
    });

    // Finalize and send invoice
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.sendInvoice(invoice.id);

    return res.status(200).json({
      success: true,
      invoiceId: finalizedInvoice.id,
      invoiceUrl: finalizedInvoice.hosted_invoice_url,
      paymentIntentId: finalizedInvoice.payment_intent,
    });
  } catch (error) {
    console.error("Stripe invoice creation error:", error);
    return res.status(500).json({
      error: "Failed to create invoice",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
