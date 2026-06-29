import {
  renderFlowEmail,
  type FlowEmailStorefrontStyle,
} from "./flow-email-templates";
import { isHttpUrl, type BlogPost } from "@milk-market/domain";

// Local escaper. Blog post fields come from a permissionless, signed Nostr
// event, so every value placed into the email HTML — text or attribute — must
// be escaped. The markdown body is NEVER rendered into email HTML; only the
// title/summary (as text) and validated http(s) URLs (as attributes) are used.
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build a seller-branded blog-post announcement email. The CTA button reuses
 * the exact default-template inline styles so `renderFlowEmail` recolors it to
 * the seller's storefront palette. `postUrl` is always our own internal themed
 * post page (never the post's optional external link-out) and `unsubscribeUrl`
 * is a signed, self-describing token URL.
 */
export function buildBlogBroadcastEmail(params: {
  post: BlogPost;
  postUrl: string;
  shopName: string;
  unsubscribeUrl: string;
  style?: FlowEmailStorefrontStyle;
}): { subject: string; html: string } {
  const { post, postUrl, shopName, unsubscribeUrl, style } = params;

  const safeTitle = escapeHtml(post.title);
  const safeSummary = post.summary ? escapeHtml(post.summary) : "";
  const safePostUrl = escapeHtml(postUrl);
  const safeUnsubUrl = escapeHtml(unsubscribeUrl);
  const safeShopName = escapeHtml(shopName);
  const imageOk = isHttpUrl(post.image) ? escapeHtml(post.image!.trim()) : "";

  const imageBlock = imageOk
    ? `<img src="${imageOk}" alt="" width="536" style="width:100%;max-width:536px;height:auto;border-radius:6px;margin:0 0 20px;display:block;" />`
    : "";

  const summaryBlock = safeSummary
    ? `<p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">${safeSummary}</p>`
    : "";

  const bodyHtml = `${imageBlock}
<h2 style="margin:0 0 16px;color:#111827;font-size:22px;font-weight:700;">${safeTitle}</h2>
${summaryBlock}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
  <tr>
    <td style="background-color:#000000;border-radius:6px;padding:12px 24px;">
      <a href="${safePostUrl}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;">Read the full post</a>
    </td>
  </tr>
</table>
<p style="margin:24px 0 0;color:#9ca3af;font-size:12px;line-height:1.5;">You're receiving this because you shopped with or subscribed to ${safeShopName}. <a href="${safeUnsubUrl}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a> from these updates.</p>`;

  return renderFlowEmail(
    `New from ${shopName}: ${post.title}`,
    bodyHtml,
    { shop_name: shopName },
    style
  );
}
