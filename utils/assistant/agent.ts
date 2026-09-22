// The seller assistant's agent loop: Anthropic tool-use over a bridge to the
// platform's MCP server. The loop is budgeted hard (rounds, tool calls, per-
// call timeouts, result truncation) so one chat message can't spin or hang.

import { getAnthropicClient, ASSISTANT_MODEL } from "./llm";
import {
  filterAssistantTools,
  isAssistantToolAllowed,
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
    canWrite
      ? "- Write actions ARE enabled for this seller. After each write, confirm in one short line what changed."
      : "- Write actions are NOT enabled for this seller yet (no agent signing key on file). If they ask you to change something, explain that the assistant is read-only until they enable agent signing in the setup card above the chat.",
    "- Keep replies tight and skimmable: short paragraphs or compact lists, no filler, no flattery.",
    "",
    `Seller pubkey: ${pubkey}`,
    `Today: ${new Date().toISOString().slice(0, 10)}`,
  ].join("\n");
}

export async function runSellerAssistant(opts: {
  pubkey: string;
  canWrite: boolean;
  messages: AssistantChatMessage[];
  mcp: AssistantMcpBridge;
}): Promise<{ reply: string; actions: AssistantAction[] }> {
  const client = await getAnthropicClient();
  if (!client) throw new AssistantUnavailableError("AI is not configured");

  const allTools = await opts.mcp.listTools();
  const tools = filterAssistantTools(allTools, opts.canWrite).map((tool) => ({
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
        system: buildSystemPrompt(opts.pubkey, opts.canWrite),
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
      if (!isAssistantToolAllowed(name, opts.canWrite)) {
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
