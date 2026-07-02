// Thin seam between the storefront AI composer and the LLM (Anthropic / Claude).
//
// This is intentionally the ONLY place that talks to the model, so the rest of
// the import feature compiles and runs (in deterministic extraction-only mode)
// when no model access is available. It supports two credential sources, in
// order of preference:
//   1. Replit AI Integrations — AI_INTEGRATIONS_ANTHROPIC_API_KEY +
//      AI_INTEGRATIONS_ANTHROPIC_BASE_URL (keyless, billed to Replit credits).
//   2. A plain ANTHROPIC_API_KEY (the seller's own Anthropic account).
// When neither is present it returns null and callers fall back to the
// deterministic draft (fail-closed / fail-open UX).

interface LLMConfig {
  apiKey: string;
  baseURL?: string;
}

function resolveConfig(): LLMConfig | null {
  const aiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  const aiBase = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  if (aiKey && aiBase) return { apiKey: aiKey, baseURL: aiBase };

  const key = process.env.ANTHROPIC_API_KEY;
  if (key) return { apiKey: key };

  return null;
}

// Balanced Claude model; recommended for most use cases (see the Replit
// Anthropic AI Integrations model list). Only models on that list are available.
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 8192;

let clientPromise: Promise<unknown> | null = null;

async function getClient(): Promise<unknown> {
  const config = resolveConfig();
  if (!config) return null; // no credentials → integration not wired yet.
  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        // Guarded dynamic import so this file type-checks and bundles even
        // before the `@anthropic-ai/sdk` package is installed.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore optional dependency, present only after the integration is added
        const mod: any = await import("@anthropic-ai/sdk");
        const Anthropic = mod.default ?? mod.Anthropic;
        return new Anthropic({
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          // Keep a single import request from hanging for minutes; on failure
          // the caller cleanly falls back to the deterministic draft.
          timeout: 30_000,
          maxRetries: 1,
        });
      } catch {
        return null;
      }
    })();
  }
  return clientPromise;
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to a best-effort slice
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Call the model with a system + user prompt and return parsed JSON, or null
 * if the model is unavailable or the response can't be parsed.
 */
export async function callLLMJson(
  system: string,
  user: string
): Promise<unknown> {
  const client: any = await getClient();
  if (!client) return null;

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    });
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const textBlock = blocks.find((b: any) => b?.type === "text");
    const text = typeof textBlock?.text === "string" ? textBlock.text : "";
    if (!text) return null;
    // The system prompt asks for JSON only; extractJson still tolerates any
    // stray prose or ```json fences the model may add around the object.
    return extractJson(text);
  } catch {
    return null;
  }
}
