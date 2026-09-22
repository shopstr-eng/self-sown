import type { NextApiRequest, NextApiResponse } from "next";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  ensureAssistantTables,
  getAssistantRawKey,
  getAssistantSigningState,
  getOrCreateAssistantKey,
  invalidateAssistantRawKey,
} from "@/utils/assistant/assistant-key";
import { McpAuthError, McpLoopbackClient } from "@/utils/assistant/mcp-client";
import {
  AssistantUnavailableError,
  runSellerAssistant,
  type AssistantChatMessage,
} from "@/utils/assistant/agent";
import {
  claimAuthEventOnce,
  extractNip98EventId,
} from "@/utils/assistant/replay-guard";

// The assistant costs real model tokens and fans out into MCP tool calls, so
// it gets both a per-IP burst cap and a per-seller hourly budget, an overall
// execution deadline, and single-use signed requests (replay guard).
const IP_LIMIT = { limit: 20, windowMs: 60 * 1000 };
const SELLER_LIMIT = { limit: 40, windowMs: 60 * 60 * 1000 };
const OVERALL_DEADLINE_MS = 90_000;

const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 4_000;

function parseMessages(body: unknown): AssistantChatMessage[] | null {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  if (messages.length > MAX_MESSAGES) return null;

  const parsed: AssistantChatMessage[] = [];
  for (const message of messages) {
    if (
      !message ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string"
    ) {
      return null;
    }
    const content = message.content.trim();
    if (!content || content.length > MAX_MESSAGE_CHARS) return null;
    parsed.push({ role: message.role, content });
  }
  // The loop needs something to answer.
  if (parsed[parsed.length - 1]?.role !== "user") return null;
  return parsed;
}

// Hard ceiling on one chat turn so a long tool chain can't pin a request.
async function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new AssistantUnavailableError("Assistant timed out")),
      OVERALL_DEADLINE_MS
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "assistant-chat:ip", IP_LIMIT))) return;

  const auth = await verifyNip98Request(req, "POST", req.body);
  if (!auth.ok) return res.status(401).json({ error: auth.error });

  // NIP-98 proves freshness but doesn't consume the event; a captured signed
  // request must not be replayable into duplicate writes.
  if (!claimAuthEventOnce(auth.pubkey, extractNip98EventId(req))) {
    return res
      .status(401)
      .json({ error: "This signed request was already used" });
  }

  if (
    !(await applyRateLimit(
      req,
      res,
      "assistant-chat:seller",
      SELLER_LIMIT,
      auth.pubkey
    ))
  ) {
    return;
  }

  // Pro-only feature — enforced server-side at the endpoint, like every other
  // server-backed Pro feature.
  if (!(await requireProEntitlement(auth.pubkey, res))) return;

  const messages = parseMessages(req.body);
  if (!messages) {
    return res.status(400).json({
      error:
        "messages must be a non-empty array of {role, content} ending with a user message",
    });
  }

  try {
    await ensureAssistantTables();
    const keyRow = await getOrCreateAssistantKey(auth.pubkey);
    const canWrite = await getAssistantSigningState(auth.pubkey, keyRow);

    const runOnce = async (rawKey: string) => {
      const bridge = new McpLoopbackClient(rawKey);
      try {
        await bridge.connect();
        // await, not bare return — the bridge must close even when the loop
        // throws (see finally).
        return await runSellerAssistant({
          pubkey: auth.pubkey,
          canWrite,
          messages,
          mcp: bridge,
        });
      } finally {
        await bridge.close();
      }
    };

    let result: Awaited<ReturnType<typeof runSellerAssistant>>;
    try {
      result = await withDeadline(
        runOnce(await getAssistantRawKey(auth.pubkey, keyRow))
      );
    } catch (error) {
      if (!(error instanceof McpAuthError)) throw error;
      // The cached raw key went stale — the assistant row was revoked in
      // settings, or another process rotated it. Evict, rotate once, retry.
      invalidateAssistantRawKey(auth.pubkey);
      result = await withDeadline(
        runOnce(await getAssistantRawKey(auth.pubkey, keyRow))
      );
    }
    return res.status(200).json({ ...result, writesEnabled: canWrite });
  } catch (error) {
    if (error instanceof AssistantUnavailableError) {
      return res.status(503).json({
        error:
          "The AI assistant is temporarily unavailable. Try again shortly.",
      });
    }
    console.error("assistant chat failed:", error);
    return res.status(500).json({ error: "Assistant request failed" });
  }
}
