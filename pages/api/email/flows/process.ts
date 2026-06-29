import { NextApiRequest, NextApiResponse } from "next";
import {
  getPendingExecutions,
  markExecutionSent,
  markExecutionFailed,
  fetchShopProfileByPubkeyFromDb,
} from "@/utils/db/db-service";
import {
  renderFlowEmail,
  MergeTagData,
  FlowEmailStorefrontStyle,
} from "@/utils/email/flow-email-templates";
import { rewriteFlowEmailLinks } from "@/utils/email/flow-link-tracking";
import { appendOpenPixel } from "@/utils/email/flow-open-tracking";
import {
  mintReviewLinkToken,
  resolveReviewOrdersUrl,
} from "@/utils/email/review-link-tokens";
import { getUncachableSendGridClient } from "@/utils/email/sendgrid-client";
import { isVerifiedSenderError } from "@/utils/email/email-service";
import { resolveSellerSenderEmail } from "@/utils/db/email-sender-domains";
import { applyRateLimit } from "@/utils/rate-limit";
import { isPubkeyProEntitled } from "@/utils/pro/membership";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (
    !(await applyRateLimit(req, res, "flows-process", {
      limit: 30,
      windowMs: 60_000,
    }))
  )
    return;

  const secret = req.headers["x-flow-processor-secret"] || req.body?.secret;
  const expectedSecret = process.env.FLOW_PROCESSOR_SECRET;

  if (!expectedSecret || secret !== expectedSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const batchSize = Math.min(parseInt(req.body?.batch_size) || 50, 50);
    const executions = await getPendingExecutions(batchSize);

    if (executions.length === 0) {
      return res.status(200).json({ processed: 0, results: [] });
    }

    let sgClient: Awaited<
      ReturnType<typeof getUncachableSendGridClient>
    > | null = null;
    try {
      sgClient = await getUncachableSendGridClient();
    } catch (error) {
      console.error("Failed to initialize SendGrid client:", error);
      return res
        .status(500)
        .json({ error: "Failed to initialize email client" });
    }

    const results: Array<{
      execution_id: number;
      status: "sent" | "failed" | "skipped";
      error?: string;
    }> = [];

    // Email flows are Pro-only. Cache per-seller entitlement for this batch so
    // we don't re-check the same seller repeatedly, and skip sends for sellers
    // who are not currently entitled (read-only/hidden/free). Skipped sends are
    // marked failed so they leave the pending queue and don't starve the batch.
    const entitlementCache = new Map<string, boolean>();
    const isSellerEntitled = async (sellerPubkey: string): Promise<boolean> => {
      if (entitlementCache.has(sellerPubkey))
        return entitlementCache.get(sellerPubkey)!;
      let entitled = false;
      try {
        entitled = await isPubkeyProEntitled(sellerPubkey);
      } catch (err) {
        console.error(
          "Failed to resolve seller entitlement for flow email:",
          sellerPubkey,
          err
        );
        entitled = false;
      }
      entitlementCache.set(sellerPubkey, entitled);
      return entitled;
    };

    // Cache per-seller storefront style for the duration of this batch so we
    // don't re-fetch the kind 30019 event for every execution from the same
    // seller. `null` means "looked up, no storefront / no colors".
    const styleCache = new Map<string, FlowEmailStorefrontStyle | null>();

    const getStorefrontStyle = async (
      sellerPubkey: string
    ): Promise<FlowEmailStorefrontStyle | null> => {
      if (styleCache.has(sellerPubkey))
        return styleCache.get(sellerPubkey) ?? null;
      try {
        const evt = await fetchShopProfileByPubkeyFromDb(sellerPubkey);
        if (!evt?.content) {
          styleCache.set(sellerPubkey, null);
          return null;
        }
        const parsed = JSON.parse(evt.content);
        const sf = parsed?.storefront;
        const cs = sf?.colorScheme;
        if (!cs && !sf?.neoShadows) {
          styleCache.set(sellerPubkey, null);
          return null;
        }
        const style: FlowEmailStorefrontStyle = {
          primary: cs?.primary,
          secondary: cs?.secondary,
          accent: cs?.accent,
          background: cs?.background,
          text: cs?.text,
          neoShadows: !!sf?.neoShadows,
        };
        styleCache.set(sellerPubkey, style);
        return style;
      } catch (err) {
        console.error(
          "Failed to load storefront style for flow email:",
          sellerPubkey,
          err
        );
        styleCache.set(sellerPubkey, null);
        return null;
      }
    };

    // Cache the resolved "orders" URL per seller for this batch so we don't
    // re-query custom_domains for every execution. Used to build {{review_link}}.
    const reviewUrlCache = new Map<string, string>();
    const baseUrlForReview =
      process.env.NEXT_PUBLIC_BASE_URL || "https://milk.market";
    const getReviewOrdersUrl = async (
      sellerPubkey: string
    ): Promise<string> => {
      if (reviewUrlCache.has(sellerPubkey))
        return reviewUrlCache.get(sellerPubkey)!;
      const url = await resolveReviewOrdersUrl(sellerPubkey, baseUrlForReview);
      reviewUrlCache.set(sellerPubkey, url);
      return url;
    };

    // Cache the seller's own authenticated sending address per batch. Fail-closed:
    // resolveSellerSenderEmail returns null unless the domain is SendGrid-validated
    // and a from-address is set, so flows fall back to the global verified sender.
    const senderEmailCache = new Map<string, string | null>();
    const getSellerSenderEmail = async (
      sellerPubkey: string
    ): Promise<string | null> => {
      if (senderEmailCache.has(sellerPubkey))
        return senderEmailCache.get(sellerPubkey)!;
      const email = await resolveSellerSenderEmail(sellerPubkey);
      senderEmailCache.set(sellerPubkey, email);
      return email;
    };

    for (const execution of executions) {
      try {
        if (!(await isSellerEntitled(execution.seller_pubkey))) {
          await markExecutionFailed(
            execution.id,
            "Skipped: seller does not have an active Herd membership"
          );
          results.push({ execution_id: execution.id, status: "skipped" });
          continue;
        }

        const mergeData: MergeTagData = {
          ...(execution.enrollment_data || {}),
          shop_name:
            execution.enrollment_data?.shop_name ||
            execution.from_name ||
            "Milk Market",
        };

        // Build the per-recipient "leave a review" deep-link for {{review_link}}.
        // Always provide a valid orders URL so the merge tag never renders an
        // empty href; add a signed token only when this email is tied to an
        // order (post-purchase / welcome-from-order). The token is what scopes
        // the dashboard to auto-open the review modal for that exact order.
        const reviewOrdersUrl = await getReviewOrdersUrl(
          execution.seller_pubkey
        );
        let reviewLink = reviewOrdersUrl;
        const reviewOrderId = execution.enrollment_data?.order_id;
        if (reviewOrderId) {
          try {
            const reviewToken = mintReviewLinkToken({
              orderId: reviewOrderId,
              productAddress:
                execution.enrollment_data?.product_address || null,
              sellerPubkey: execution.seller_pubkey,
              buyerPubkey: execution.recipient_pubkey || null,
            });
            reviewLink = `${reviewOrdersUrl}?review=${encodeURIComponent(
              reviewToken
            )}`;
          } catch {
            // No signing secret configured — fall back to the plain orders URL.
          }
        }
        mergeData.review_link = reviewLink;

        const sfStyle = await getStorefrontStyle(execution.seller_pubkey);

        const { subject, html } = renderFlowEmail(
          execution.subject,
          execution.body_html,
          mergeData,
          sfStyle ?? undefined
        );

        // Route every http(s) CTA/link through our signed tracking redirect so
        // seller-facing click analytics work. Failures here degrade to the
        // original links (the util returns the html unchanged).
        const baseUrl =
          process.env.NEXT_PUBLIC_BASE_URL || "https://milk.market";
        const trackedHtml = rewriteFlowEmailLinks(html, {
          baseUrl,
          flowId: execution.flow_id,
          stepId: execution.step_id,
          enrollmentId: execution.enrollment_id,
          executionId: execution.id,
          sellerPubkey: execution.seller_pubkey,
        });

        // Append a hidden tracking pixel so seller-facing open analytics work.
        // If no signing secret is configured the util returns html unchanged.
        const finalHtml = appendOpenPixel(trackedHtml, baseUrl, {
          flowId: execution.flow_id,
          stepId: execution.step_id,
          enrollmentId: execution.enrollment_id,
          executionId: execution.id,
          sellerPubkey: execution.seller_pubkey,
        });

        // Prefer the seller's own authenticated sending domain when valid;
        // otherwise use the platform's global verified sender.
        const customFromEmail = execution.seller_pubkey
          ? await getSellerSenderEmail(execution.seller_pubkey)
          : null;
        const senderEmail = customFromEmail || sgClient.fromEmail;

        const buildFrom = (sender: string) =>
          execution.from_name
            ? { email: sender, name: execution.from_name }
            : sender;

        const msg: any = {
          to: execution.recipient_email,
          from: buildFrom(senderEmail),
          subject,
          html: finalHtml,
        };

        if (execution.reply_to) {
          msg.replyTo = execution.reply_to;
        }

        try {
          await sgClient.client.send(msg);
        } catch (sendError) {
          // Never let a seller's custom from-address break delivery: retry once
          // with the global verified sender on an unverified-sender rejection.
          if (customFromEmail && isVerifiedSenderError(sendError)) {
            console.error(
              "Flow custom sender rejected by SendGrid; retrying with default sender:",
              customFromEmail
            );
            await sgClient.client.send({
              ...msg,
              from: buildFrom(sgClient.fromEmail),
            });
          } else {
            throw sendError;
          }
        }

        await markExecutionSent(execution.id);
        results.push({ execution_id: execution.id, status: "sent" });
      } catch (error: any) {
        const errorMessage = error?.message || "Unknown error sending email";
        await markExecutionFailed(execution.id, errorMessage);
        results.push({
          execution_id: execution.id,
          status: "failed",
          error: errorMessage,
        });
      }
    }

    const sent = results.filter((r) => r.status === "sent").length;
    const failed = results.filter((r) => r.status === "failed").length;

    return res.status(200).json({
      processed: results.length,
      sent,
      failed,
      results,
    });
  } catch (error) {
    console.error("Error processing email flow executions:", error);
    return res.status(500).json({ error: "Failed to process executions" });
  }
}
