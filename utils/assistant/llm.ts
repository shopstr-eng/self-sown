// Guarded Anthropic seam for the seller assistant's agent loop. Mirrors the
// credential resolution of utils/storefront/llm-json.ts (Replit AI
// Integrations first, a plain ANTHROPIC_API_KEY second) but exposes raw
// messages.create so the agent can drive tool use. Returns null when no
// credentials exist so the route can fail closed with a clean 503.

// Balanced Claude model; must stay on the Replit AI Integrations model list
// (same constraint as utils/storefront/llm-json.ts).
export const ASSISTANT_MODEL = "claude-sonnet-4-6";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let clientPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getAnthropicClient(): Promise<any | null> {
  const aiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  const aiBase = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const apiKey = aiKey && aiBase ? aiKey : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const baseURL = aiKey && aiBase ? aiBase : undefined;

  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        // Guarded dynamic import so this module type-checks and bundles even
        // where the SDK isn't installed.

        // @ts-ignore optional dependency, present after the integration is added
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod: any = await import("@anthropic-ai/sdk");
        const Anthropic = mod.default ?? mod.Anthropic;
        return new Anthropic({
          apiKey,
          baseURL,
          // A stalled model call must not pin a request for minutes; the
          // agent loop degrades to a clean error instead.
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
