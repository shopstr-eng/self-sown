// Embedding seam for semantic (pgvector) retrieval. Anthropic has no
// embeddings API, so embeddings come from a Voyage-compatible endpoint when
// VOYAGE_API_KEY is configured; otherwise this returns null and retrieval
// falls back to Postgres full-text search (utils/regulations/store.ts).
// Null is a normal operating mode, not an error — retrieval never decides.

const VOYAGE_MODEL = "voyage-3"; // 1024 dims — matches the vector(1024) column.

export async function embedCorpusText(text: string): Promise<number[] | null> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input: text.slice(0, 8_000),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn("[regulations] embedding request failed:", response.status);
      return null;
    }
    const body = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = body.data?.[0]?.embedding;
    return Array.isArray(embedding) && embedding.length === 1024
      ? embedding
      : null;
  } catch (error) {
    console.warn(
      "[regulations] embedding unavailable:",
      error instanceof Error ? error.message : error
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
