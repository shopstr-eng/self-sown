// Corpus store: the only DB accessors the regulation engine and chat use.
//
// Two load-bearing rules (see .agents/memory/db-lookup-null-vs-outage.md):
//   1. A DB error THROWS — the route turns it into a 503. Null/empty means
//      the corpus genuinely has no rows, which is a lawful "unknown" answer.
//   2. Every row is re-validated against the zod schema on the way out. A row
//      that fails validation (e.g. a hand-edited citation) is dropped loudly
//      and can only drag the answer toward "unknown", never toward a
//      citation-less answer.

import { getDbPool } from "@/utils/db/db-service";
import {
  agencyContactSchema,
  corpusRuleSchema,
  type AgencyContact,
  type CorpusRule,
} from "./schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseRules(rows: any[]): CorpusRule[] {
  const valid: CorpusRule[] = [];
  for (const row of rows) {
    const parsed = corpusRuleSchema.safeParse({
      ...row,
      // pg returns DATE columns as Date objects; the schema carries the
      // canonical YYYY-MM-DD string form.
      effective_date: toDateString(row.effective_date),
      last_verified_at: toDateString(row.last_verified_at),
      conditions: Array.isArray(row.conditions) ? row.conditions : [],
    });
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      console.error("[regulations] dropping invalid corpus row", {
        id: row?.id,
        issues: parsed.error.issues.map((i) => i.path.join(".")),
      });
    }
  }
  return valid;
}

function toDateString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === "string" ? value.slice(0, 10) : null;
}

// All rules for a state × category (every channel). The engine applies the
// channel filter itself so "channel not covered" stays distinguishable from
// "category not covered".
export async function fetchCorpusRules(
  state: string,
  category: string
): Promise<CorpusRule[]> {
  const { rows } = await getDbPool().query(
    `SELECT id, state, category, channel, decision, conditions, summary,
            citation_url, citation_title, statute_excerpt,
            effective_date, last_verified_at, tier
     FROM regulation_corpus_rules
     WHERE state = $1 AND category = $2`,
    [state, category]
  );
  return parseRules(rows);
}

// Category-specific contact wins over the state-level default (category NULL).
export async function fetchAgencyContact(
  state: string,
  category: string | null
): Promise<AgencyContact | null> {
  const { rows } = await getDbPool().query(
    `SELECT state, category, agency_name, contact_url, phone, email
     FROM regulation_agency_contacts
     WHERE state = $1 AND (category = $2 OR category IS NULL)
     ORDER BY category NULLS LAST
     LIMIT 1`,
    [state, category]
  );
  if (rows.length === 0) return null;
  const parsed = agencyContactSchema.safeParse(rows[0]);
  if (!parsed.success) {
    console.error("[regulations] dropping invalid agency contact", {
      state,
      category,
    });
    return null;
  }
  return parsed.data;
}

export interface RetrievedExcerpt {
  ruleId: string;
  citationUrl: string;
  citationTitle: string;
  summary: string;
  excerpt: string;
  score: number;
}

// Retrieval for the explain step. Full-text rank over summary + excerpt,
// optionally blended with pgvector cosine similarity when an embedding for
// the question is available. Retrieval never decides anything — it only
// chooses which already-validated excerpts the explainer may quote.
export async function retrieveCorpusExcerpts(params: {
  state: string | null;
  category: string | null;
  query: string;
  embedding: number[] | null;
  limit?: number;
}): Promise<RetrievedExcerpt[]> {
  const limit = params.limit ?? 5;
  const filters: string[] = [];
  const values: unknown[] = [params.query];
  if (params.state) {
    values.push(params.state);
    filters.push(`state = $${values.length}`);
  }
  if (params.category) {
    values.push(params.category);
    filters.push(`category = $${values.length}`);
  }
  const where = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";

  // Vector path only when a query embedding exists AND the column does;
  // otherwise plain tsvector rank. Score ties break toward verified-recently.
  if (params.embedding) {
    values.push(`[${params.embedding.join(",")}]`);
    const vecParam = `$${values.length}`;
    values.push(limit);
    const { rows } = await getDbPool().query(
      `SELECT id, citation_url, citation_title, summary, statute_excerpt,
              ts_rank(search_tsv, plainto_tsquery('english', $1)) AS fts_rank,
              embedding <=> ${vecParam}::vector AS vec_dist
       FROM regulation_corpus_rules
       WHERE embedding IS NOT NULL ${where}
       ORDER BY (ts_rank(search_tsv, plainto_tsquery('english', $1)) + GREATEST(0, 1 - (embedding <=> ${vecParam}::vector))) DESC,
                last_verified_at DESC
       LIMIT $${values.length}`,
      values
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((row: any) => ({
      ruleId: row.id,
      citationUrl: row.citation_url,
      citationTitle: row.citation_title,
      summary: row.summary,
      excerpt: row.statute_excerpt,
      score: Number(row.fts_rank) + Math.max(0, 1 - Number(row.vec_dist)),
    }));
  }

  values.push(limit);
  const { rows } = await getDbPool().query(
    `SELECT id, citation_url, citation_title, summary, statute_excerpt,
            ts_rank(search_tsv, plainto_tsquery('english', $1)) AS rank
     FROM regulation_corpus_rules
     WHERE search_tsv @@ plainto_tsquery('english', $1) ${where}
     ORDER BY rank DESC, last_verified_at DESC
     LIMIT $${values.length}`,
    values
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((row: any) => ({
    ruleId: row.id,
    citationUrl: row.citation_url,
    citationTitle: row.citation_title,
    summary: row.summary,
    excerpt: row.statute_excerpt,
    score: Number(row.rank),
  }));
}
