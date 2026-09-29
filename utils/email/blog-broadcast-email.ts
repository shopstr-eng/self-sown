import {
  renderFlowEmail,
  type FlowEmailStorefrontStyle,
} from "./flow-email-templates";
import { isHttpUrl, type BlogPost } from "@self-sown/domain";

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

// Post fields come from a parsed Nostr event / captured broadcast row —
// mutable JSON, not compile-time strings. A numeric or object-shaped field
// would crash escapeHtml (x.replace is not a function) and silently drop the
// broadcast. Coerce numbers and booleans, drop anything else that isn't a
// string.
function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function esc(value: unknown): string {
  return escapeHtml(asString(value));
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

  // Coerce BEFORE truthiness checks: an object-shaped field must collapse to
  // "" (and drop its block), not pass a truthiness check and crash or render
  // an empty slot.
  const titleText = asString(post.title);
  const shopNameText = asString(shopName);
  const safeTitle = esc(post.title);
  const safeSummary = esc(post.summary);
  const safePostUrl = esc(postUrl);
  const safeUnsubUrl = esc(unsubscribeUrl);
  const safeShopName = escapeHtml(shopNameText);
  const imageOk = isHttpUrl(post.image) ? escapeHtml(post.image.trim()) : "";

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
    `New from ${shopNameText}: ${titleText}`,
    bodyHtml,
    { shop_name: shopNameText },
    style
  );
}
