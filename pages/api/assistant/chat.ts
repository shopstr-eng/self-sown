import type { NextApiRequest, NextApiResponse } from "next";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { requireProEntitlement } from "@/utils/pro/require-pro";
import { applyRateLimit } from "@/utils/rate-limit";
import { fetchShopProfileByPubkeyFromDb } from "@/utils/db/db-service";
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
  runBuyerAssistant,
  runSellerAssistant,
  type AssistantChatMessage,
} from "@/utils/assistant/agent";
import { parseAssistantVisibilityFromContent } from "@/utils/assistant/stall-visibility";
import {
  claimAuthEventOnce,
  extractNip98EventId,
} from "@/utils/assistant/replay-guard";
import { verifyAssistantSessionToken } from "@/utils/assistant/session-token";

// The assistant costs real model tokens and fans out into MCP tool calls, so
// it gets both a per-IP burst cap and a per-seller hourly budget, an overall
// execution deadline, and single-use signed requests (replay guard).
const IP_LIMIT = { limit: 20, windowMs: 60 * 1000 };
const SELLER_LIMIT = { limit: 40, windowMs: 60 * 60 * 1000 };
// Guest/buyer storefront chat is unauthenticated, so its budget is IP-keyed
// and tighter than a signed-in seller's.
const BUYER_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 };
// NOTE: this route must stay in proxy.ts CUSTOM_DOMAIN_API_ALLOWLIST — buyer
// chat posts to it from seller custom domains.
const OVERALL_DEADLINE_MS = 90_000;

const HEX64 = /^[0-9a-f]{64}$/;

// Optional stall context: present when the chat runs on a custom stall
// (storefront route or custom domain). Drives the buyer/seller audience split.
function parseStallPubkey(body: unknown): string | null {
  const stallPubkey = (body as { context?: { stallPubkey?: unknown } })?.context
    ?.stallPubkey;
  if (typeof stallPubkey !== "string" || !HEX64.test(stallPubkey)) return null;
  return stallPubkey;
}

// Buyer/guest storefront chat: no NIP-98, no account — an anonymous MCP
// session (public catalog tools only) behind the stall's opt-in toggle.
// Unlike the seller assistant this is NOT Pro-gated: the buyer surface only
// reads public catalog data any storefront visitor can already see.
async function handleBuyerChat(
  req: NextApiRequest,
  res: NextApiResponse,
  stallPubkey: string
) {
  if (!(await applyRateLimit(req, res, "assistant-chat:buyer", BUYER_LIMIT))) {
    return;
  }

  const shopEvent = await fetchShopProfileByPubkeyFromDb(stallPubkey);
  const { buyers, shopName } = parseAssistantVisibilityFromContent(
    shopEvent?.content
  );
  if (!buyers) {
    return res
      .status(403)
      .json({ error: "The assistant is not available on this shop." });
  }

  const messages = parseMessages(req.body);
  if (!messages) {
    return res.status(400).json({
      error:
        "messages must be a non-empty array of {role, content} ending with a user message",
    });
  }

  const bridge = new McpLoopbackClient(); // anonymous session: public reads only
  try {
    await bridge.connect();
    const result = await withDeadline(
      runBuyerAssistant({ shopName, stallPubkey, messages, mcp: bridge })
    );
    return res.status(200).json({ ...result, audience: "buyer" });
  } catch (error) {
    if (error instanceof AssistantUnavailableError) {
      return res.status(503).json({
        error:
          "The AI assistant is temporarily unavailable. Try again shortly.",
      });
    }
    console.error("buyer assistant chat failed:", error);
    return res.status(500).json({ error: "Assistant request failed" });
  } finally {
    await bridge.close();
  }
}

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

  const stallPubkey = parseStallPubkey(req.body);

  // Two auth schemes: a per-request NIP-98 signature, or a short-lived
  // session bearer token minted from one NIP-98 signature (so NIP-07/NIP-46
  // users approve once per window, not once per message). The bearer token is
  // verified server-side on every request and carries its own expiry.
  const authorization = req.headers.authorization;
  const isBearer =
    typeof authorization === "string" && authorization.startsWith("Bearer ");
  const bearerSession = isBearer
    ? verifyAssistantSessionToken(authorization.slice(7).trim())
    : null;
  const auth: { ok: true; pubkey: string } | { ok: false; error: string } =
    isBearer
      ? bearerSession
        ? { ok: true, pubkey: bearerSession.pubkey }
        : { ok: false, error: "Invalid or expired assistant session" }
      : await verifyNip98Request(req, "POST", req.body);

  // On a custom stall, anyone who is NOT the stall's own signed-in seller —
  // guests and signed-in buyers alike — gets the buyer assistant: public
  // catalog tools only, no account access. No NIP-98 is required for it.
  if (stallPubkey && (!auth.ok || auth.pubkey !== stallPubkey)) {
    // Awaited statement, not `return handleX(...)`: a bare return would let
    // an async throw escape the handler (and eslint's return-await rule
    // strips `return await` outside try/catch).
    await handleBuyerChat(req, res, stallPubkey);
    return;
  }

  if (!auth.ok) return res.status(401).json({ error: auth.error });

  // NIP-98 proves freshness but doesn't consume the event; a captured signed
  // request must not be replayable into duplicate writes. Bearer tokens are
  // multi-use by design (that's their purpose), but they expire on their own
  // and the per-seller rate limit + Pro gate below still apply.
  if (
    !isBearer &&
    !claimAuthEventOnce(auth.pubkey, extractNip98EventId(req))
  ) {
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
