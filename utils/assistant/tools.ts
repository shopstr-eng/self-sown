// Curated MCP tool surface for the in-app seller assistant (Settings → AI
// Assistant). The assistant is a real client of the platform's MCP server,
// but with a deliberately tighter surface than a full_access API key:
// no fund movement, no deletes of listings/discounts/flows, no direct
// messaging to buyers, no decrypted message content (DM bodies never go to
// the AI provider), and no billing/relay/server config. Order-status and
// shipping-update tools DO send templated buyer notifications — that is
// normal fulfillment, and the seller triggers it from the chat. One-off
// broadcast emails and Shippo label purchases ARE in scope: broadcasts fail
// closed on the seller's verified sender domain with per-recipient
// idempotency, and labels bill to the seller's own connected Shippo account
// behind an atomic one-label-per-order claim.
//
// Everything the assistant reads (including order details such as buyer
// email/shipping address) is sent to the AI provider to generate answers;
// the assistant page and FAQ disclose this.

export type AssistantToolClass = "read" | "write";

const READ_TOOLS = [
  // catalog / storefront reads
  "search_products",
  "get_categories",
  "get_product_details",
  "list_companies",
  "get_company_details",
  "get_storefront",
  "get_reviews",
  "check_discount_code",
  "get_membership_status",
  // seller order + ops reads
  "list_seller_orders",
  "get_order_status",
  "get_notifications",
  "get_email_analytics",
  "get_stock",
  "list_email_flows",
  "get_email_flow_stats",
  "list_email_captures",
  "get_email_popup",
  "get_notification_email",
  "list_discount_codes",
  "get_shipping_label_status",
  "get_cashu_balance",
  "get_stripe_connect_status",
  "list_affiliates",
  "list_affiliate_codes",
  "list_affiliate_click_stats",
  "list_affiliate_payouts",
  "list_failed_relay_publishes",
] as const;

const WRITE_TOOLS = [
  // stall + profile
  "set_user_profile",
  "set_shop_profile",
  "register_shop_slug",
  "set_storefront_policies",
  // products + inventory
  "create_product_listing",
  "update_product_listing",
  "set_stock",
  // order fulfillment
  "update_order_status",
  "update_order_address",
  "send_shipping_update",
  // community + reviews
  "reply_to_review",
  "create_community_post",
  // email + storefront capture
  "set_email_popup",
  "set_notification_email",
  "create_email_flow",
  "update_email_flow",
  "toggle_email_flow",
  "send_test_email",
  "send_broadcast_email",
  // shipping labels
  "purchase_shipping_label",
  // discounts
  "create_discount_code",
  "update_discount_code",
  // relay recovery
  "retry_failed_relay_publish",
] as const;

export const ASSISTANT_TOOLS: Record<string, AssistantToolClass> = {
  ...Object.fromEntries(READ_TOOLS.map((name) => [name, "read"])),
  ...Object.fromEntries(WRITE_TOOLS.map((name) => [name, "write"])),
};

export function isAssistantToolAllowed(
  name: string,
  canWrite: boolean
): boolean {
  const toolClass = ASSISTANT_TOOLS[name];
  if (!toolClass) return false;
  return toolClass === "read" || canWrite;
}

export function filterAssistantTools<T extends { name: string }>(
  tools: T[],
  canWrite: boolean
): T[] {
  return tools.filter((tool) => isAssistantToolAllowed(tool.name, canWrite));
}

export function prettifyToolName(name: string): string {
  return name.replace(/_/g, " ");
}
