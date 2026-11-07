import type { PoolClient } from "pg";
import { getDbPool, withSchemaDdlLock } from "./db-service";

// Keep the standalone db/schema.sql block byte-for-byte in sync (same
// contract as MOBILE_NOTIFICATION_SCHEMA — the schema-parity test asserts
// it). Runtime bootstrap is initializeTables() in db-service.ts; schema.sql
// serves self-host standalone installs.
//
// Citation/excerpt/last_verified are NOT NULL with content CHECKs: a corpus
// row without a verifiable source is invalid at the database layer too, not
// just in zod. search_tsv (full-text retrieval) lives IN the CREATE TABLE so
// both install paths get it; the tables are new, so CREATE TABLE IF NOT
// EXISTS covers every install.
export const REGULATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS regulation_agency_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  category TEXT CHECK (category IS NULL OR category ~ '^[a-z][a-z0-9_]*$'),
  agency_name TEXT NOT NULL CHECK (length(btrim(agency_name)) > 0),
  contact_url TEXT NOT NULL CHECK (contact_url ~ '^https?://'),
  phone TEXT,
  email TEXT,
  last_verified_at DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_regulation_agency_contacts_state ON regulation_agency_contacts(state, category);

CREATE TABLE IF NOT EXISTS regulation_corpus_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  category TEXT NOT NULL CHECK (category ~ '^[a-z][a-z0-9_]*$'),
  channel TEXT NOT NULL CHECK (channel ~ '^[a-z][a-z0-9_]*$'),
  decision TEXT NOT NULL CHECK (decision IN ('allowed','conditional','prohibited')),
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT NOT NULL CHECK (length(btrim(summary)) > 0),
  citation_url TEXT NOT NULL CHECK (citation_url ~ '^https?://'),
  citation_title TEXT NOT NULL CHECK (length(btrim(citation_title)) > 0),
  statute_excerpt TEXT NOT NULL CHECK (length(btrim(statute_excerpt)) > 0),
  effective_date DATE,
  last_verified_at DATE NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('statute_verified','agency_guidance')),
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', summary || ' ' || statute_excerpt)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_regulation_corpus_rules_slot ON regulation_corpus_rules(state, category, channel);
CREATE INDEX IF NOT EXISTS idx_regulation_corpus_rules_tsv ON regulation_corpus_rules USING gin(search_tsv);
`;

export async function ensureRegulationsSchema(
  client: Pick<PoolClient, "query">
): Promise<void> {
  await withSchemaDdlLock(client, async () => {
    await client.query(REGULATIONS_SCHEMA);
  });
}

// pgvector for semantic retrieval. This MUST NOT run inside the shared DDL
// transaction: self-host Postgres may lack the extension, and a failed
// statement aborts the surrounding transaction — the ensuing COMMIT would
// silently roll back the entire schema batch while initializeTables still
// reports success. It runs afterwards on a fresh pooled connection, so a
// failure poisons nothing; retrieval just stays full-text only (the
// embedding column never exists and store.ts's vector path requires one).
export async function ensureRegulationsVectorSupport(): Promise<void> {
  try {
    const pool = getDbPool();
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS vector;
      ALTER TABLE regulation_corpus_rules ADD COLUMN IF NOT EXISTS embedding vector(1024);
      CREATE INDEX IF NOT EXISTS idx_regulation_corpus_rules_embedding ON regulation_corpus_rules USING hnsw (embedding vector_cosine_ops);
    `);
  } catch (error) {
    console.warn(
      "[regulations] pgvector unavailable; retrieval is full-text only:",
      error instanceof Error ? error.message : error
    );
  }
}
