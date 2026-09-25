// The seller assistant's agent loop: Anthropic tool-use over a bridge to the
// platform's MCP server. The loop is budgeted hard (rounds, tool calls, per-
// call timeouts, result truncation) so one chat message can't spin or hang.

import { getAnthropicClient, ASSISTANT_MODEL } from "./llm";
import {
  filterAssistantTools,
  filterBuyerAssistantTools,
  isAssistantToolAllowed,
  isBuyerToolAllowed,
  prettifyToolName,
} from "./tools";

export class AssistantUnavailableError extends Error {}

export interface AssistantChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantAction {
  tool: string;
  ok: boolean;
  detail: string;
  // Display payload for a purchased shipping label, lifted out of the tool's
  // JSON result so the chat can render a clickable card (presentation only).
  label?: PurchasedLabelInfo;
}

// Mirrors utils/shipping/auto-purchase.ts PurchasedLabelInfo, re-declared so
// the assistant module stays independent of the shipping module graph.
export interface PurchasedLabelInfo {
  trackingCode: string | null;
  trackingUrl: string | null;
  labelUrl: string;
  labelFormat: string;
  rate: number;
  currency: string;
  carrier: string;
  service: string;
}

export interface AssistantMcpBridge {
  listTools(): Promise<
    Array<{ name: string; description?: string; inputSchema?: unknown }>
  >;
  callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ text: string; isError: boolean }>;
}

const MAX_HISTORY_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_ROUNDS = 6;
const MAX_TOOL_CALLS = 12;
const MAX_TOOL_RESULT_CHARS = 6_000;
const MAX_ACTION_DETAIL_CHARS = 280;
const MAX_TOKENS = 4_096;

// Lift the purchased-label display payload out of a tool's JSON result text
// so the chat can render tracking/download links. Parsed from the tool's own
// structured output (not model text); anything malformed yields no card.
// Exported for unit tests.
export function extractPurchasedLabel(
  toolName: string,
  resultText: string
): PurchasedLabelInfo | undefined {
  if (toolName !== "purchase_shipping_label") return undefined;
  try {
    const parsed = JSON.parse(resultText) as {
      label?: Record<string, unknown> | null;
    };
    const label = parsed?.label;
    if (!label || typeof label !== "object") return undefined;
    const { labelUrl, labelFormat, rate, currency, carrier, service } = label;
    if (
      typeof labelUrl !== "string" ||
      !labelUrl ||
      typeof labelFormat !== "string" ||
      typeof rate !== "number" ||
      typeof currency !== "string" ||
      typeof carrier !== "string" ||
      typeof service !== "string"
    ) {
      return undefined;
    }
    return {
      trackingCode:
        typeof label.trackingCode === "string" ? label.trackingCode : null,
      trackingUrl:
        typeof label.trackingUrl === "string" ? label.trackingUrl : null,
      labelUrl,
      labelFormat,
      rate,
      currency,
      carrier,
      service,
    };
  } catch {
    return undefined;
  }
}

function buildSystemPrompt(pubkey: string, canWrite: boolean): string {
  return [
    "You are the Self-sown Seller Assistant, built into the seller dashboard of Self-sown, a local-food and artisan-goods marketplace on Nostr.",
    "You act on the seller's own account through the marketplace's MCP tools.",
    "",
    "Ground rules:",
    "- Use tools for anything that needs live account data; never invent listings, orders, stock counts, or balances.",
    "- When asked to change something and the needed tool is available, do it directly, then confirm concisely what changed.",
    "- If a tool errors, explain the cause in plain language and suggest the fix.",
    "- Fund movement (Cashu/Bitcoin/Stripe), deleting listings/discount codes/flows, sending direct messages to buyers, reading buyer DMs, media uploads, and billing/relay/server settings are NOT available here; explain those stay manual in the dashboard. Order-status and shipping updates DO send the buyer a templated notification — that is normal fulfillment.",
    "- You can send one-off broadcast emails to the seller's audience (send_broadcast_email) — for fresh content, offer a send_test_email preview first. You can also check which paid orders still need labels (get_shipping_label_status) and buy them (purchase_shipping_label, billed to the seller's connected Shippo account); confirm the count and cost implication before buying several at once.",
    canWrite
      ? "- Write actions ARE enabled for this seller. After each write, confirm in one short line what changed."
      : "- Write actions are NOT enabled for this seller yet (no agent signing key on file). If they ask you to change something, explain that the assistant is read-only until they enable agent signing in the setup card above the chat.",
    "- Keep replies tight and skimmable: short paragraphs or compact lists, no filler, no flattery.",
    "",
    `Seller pubkey: ${pubkey}`,
    `Today: ${new Date().toISOString().slice(0, 10)}`,
  ].join("\n");
}

function buildBuyerSystemPrompt(shopName: string | null): string {
  return [
    `You are the shopping assistant for ${shopName || "this shop"}, a storefront on Self-sown, a local-food and artisan-goods marketplace on Nostr.`,
    "You help visitors discover this shop's products through the marketplace's public catalog tools.",
    "",
    "Ground rules:",
    "- Use tools for anything about products, categories, reviews, or discount codes; never invent items, prices, stock, or policies.",
    "- You can only see PUBLIC catalog data. You have no access to anyone's account, orders, or messages, and you cannot place or change orders — direct buyers to the shop's own checkout and contact options.",
    "- Your catalog tools are pre-scoped to THIS shop's products, storefront, and reviews; you cannot browse other sellers. If a visitor asks about products or shops elsewhere, say you only cover this shop.",
    "- Keep replies tight and skimmable: short paragraphs or compact lists, no filler, no flattery.",
    "",
    `Today: ${new Date().toISOString().slice(0, 10)}`,
  ].join("\n");
}

interface AssistantLoopConfig {
  systemPrompt: string;
  filterTools: <T extends { name: string }>(tools: T[]) => T[];
  isAllowed: (name: string) => boolean;
}

async function runAssistantLoop(
  opts: { messages: AssistantChatMessage[]; mcp: AssistantMcpBridge },
  config: AssistantLoopConfig
): Promise<{ reply: string; actions: AssistantAction[] }> {
  const client = await getAnthropicClient();
  if (!client) throw new AssistantUnavailableError("AI is not configured");

  const allTools = await opts.mcp.listTools();
  const tools = config.filterTools(allTools).map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    input_schema: (tool.inputSchema as object) || {
      type: "object",
      properties: {},
    },
  }));

  const history = opts.messages.slice(-MAX_HISTORY_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content.slice(0, MAX_MESSAGE_CHARS),
  }));

  const actions: AssistantAction[] = [];
  let toolCalls = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [...history];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let response: any;
    try {
      response = await client.messages.create({
        model: ASSISTANT_MODEL,
        max_tokens: MAX_TOKENS,
        system: config.systemPrompt,
        tools,
        messages,
      });
    } catch (error) {
      if (round === 0) {
        throw new AssistantUnavailableError("AI request failed");
      }
      // Mid-loop model failure: report partial progress instead of losing it.
      console.warn("seller assistant mid-loop model error:", error);
      return {
        reply:
          "I hit an AI error partway through. The actions listed above did complete — please retry anything that's missing.",
        actions,
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any[] = Array.isArray(response?.content)
      ? response.content
      : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolUses = content.filter((block: any) => block?.type === "tool_use");

    if (toolUses.length === 0) {
      const reply = content
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((block: any) => block?.type === "text")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((block: any) => block.text as string)
        .join("\n")
        .trim();
      return { reply: reply || "Done.", actions };
    }

    messages.push({ role: "assistant", content });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolResults: any[] = [];

    for (const toolUse of toolUses) {
      const name = String(toolUse.name);
      if (toolCalls >= MAX_TOOL_CALLS) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: [
            {
              type: "text",
              text: "Tool call budget exceeded for this message.",
            },
          ],
        });
        continue;
      }
      toolCalls++;

      // Defense in depth: the allowlist is enforced again at call time, so a
      // model hallucinating an out-of-scope tool name gets a clean refusal.
      if (!config.isAllowed(name)) {
        const detail = "Not available to the in-app assistant";
        actions.push({ tool: prettifyToolName(name), ok: false, detail });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: [{ type: "text", text: `Tool ${name} is ${detail}.` }],
        });
        continue;
      }

      try {
        const result = await opts.mcp.callTool(
          name,
          (toolUse.input as Record<string, unknown>) || {}
        );
        actions.push({
          tool: prettifyToolName(name),
          ok: !result.isError,
          detail: result.text.slice(0, MAX_ACTION_DETAIL_CHARS),
          // The detail above is truncated for the action row; the label card
          // needs the full structured payload parsed from the result text.
          label: result.isError
            ? undefined
            : extractPurchasedLabel(name, result.text),
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: result.isError,
          content: [
            {
              type: "text",
              text:
                result.text.slice(0, MAX_TOOL_RESULT_CHARS) || "(no output)",
            },
          ],
        });
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "Tool call failed";
        actions.push({
          tool: prettifyToolName(name),
          ok: false,
          detail: detail.slice(0, MAX_ACTION_DETAIL_CHARS),
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: [{ type: "text", text: detail }],
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    reply:
      "I hit my step limit for one message. The actions listed above did complete — ask me to continue if anything is left.",
    actions,
  };
}

export async function runSellerAssistant(opts: {
  pubkey: string;
  canWrite: boolean;
  messages: AssistantChatMessage[];
  mcp: AssistantMcpBridge;
}): Promise<{ reply: string; actions: AssistantAction[] }> {
  return runAssistantLoop(opts, {
    systemPrompt: buildSystemPrompt(opts.pubkey, opts.canWrite),
    filterTools: (tools) => filterAssistantTools(tools, opts.canWrite),
    isAllowed: (name) => isAssistantToolAllowed(name, opts.canWrite),
  });
}

// The buyer assistant's catalog tools search the WHOLE marketplace by
// default. Ground every lookup to the stall being viewed so "What do you
// sell?" answers with this shop's inventory — the wrapper overrides any
// seller/slug argument the model supplies, so a prompt-injected instruction
// can't steer buyers to another seller's catalog either.
export function groundBuyerToolsToStall(
  mcp: AssistantMcpBridge,
  stallPubkey: string
): AssistantMcpBridge {
  return {
    listTools: () => mcp.listTools(),
    callTool: (name, args) => {
      if (name === "search_products") {
        return mcp.callTool(name, { ...args, seller: stallPubkey });
      }
      if (name === "get_storefront") {
        const rest = { ...args };
        delete rest.slug; // a model-supplied slug could name another shop
        return mcp.callTool(name, { ...rest, pubkey: stallPubkey });
      }
      if (name === "get_reviews") {
        // Force the seller filter even for product-specific lookups: a
        // model-supplied productId alone would read another shop's reviews.
        return mcp.callTool(name, { ...args, sellerPubkey: stallPubkey });
      }
      if (name === "check_discount_code") {
        return mcp.callTool(name, { ...args, sellerPubkey: stallPubkey });
      }
      if (name === "get_product_details") {
        // The product id is model-supplied and could name ANOTHER shop's
        // product. Verify ownership from the (public) result so the buyer
        // assistant only ever answers about this shop's catalog.
        return mcp.callTool(name, args).then((result) => {
          if (result.isError) return result;
          try {
            const parsed = JSON.parse(result.text) as { pubkey?: unknown };
            if (parsed?.pubkey && parsed.pubkey !== stallPubkey) {
              return {
                text: JSON.stringify({
                  error: "That product isn't from this shop.",
                }),
                isError: true,
              };
            }
          } catch {
            // Unparseable result: pass it through unchanged.
          }
          return result;
        });
      }
      return mcp.callTool(name, args);
    },
  };
}

// The buyer-facing storefront assistant: guests and signed-in buyers on a
// custom stall. Runs over an anonymous MCP session and the public-catalog
// tool allowlist only — no seller account data, no order placement, no writes.
export async function runBuyerAssistant(opts: {
  shopName: string | null;
  stallPubkey: string;
  messages: AssistantChatMessage[];
  mcp: AssistantMcpBridge;
}): Promise<{ reply: string; actions: AssistantAction[] }> {
  return runAssistantLoop(
    {
      messages: opts.messages,
      mcp: groundBuyerToolsToStall(opts.mcp, opts.stallPubkey),
    },
    {
      systemPrompt: buildBuyerSystemPrompt(opts.shopName),
      filterTools: filterBuyerAssistantTools,
      isAllowed: isBuyerToolAllowed,
    }
  );
}
