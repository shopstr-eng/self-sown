/**
 * Regulation corpus seeder.
 *
 * Usage:
 *   pnpm tsx scripts/seed-regulations-corpus.ts            # dry-run report
 *   pnpm tsx scripts/seed-regulations-corpus.ts --apply    # load into the DB
 *
 * Loads the wedge corpus (utils/regulations/corpus) into
 * regulation_corpus_rules + regulation_agency_contacts. The corpus files are
 * the source of truth: this script replaces every rule row for the wedge
 * state×category slots and every contact row for the wedge states, so
 * removed rows disappear and edits take effect. Ids are deterministic
 * (sha256 of the rule slug), so reseeding is idempotent.
 *
 * The corpus is REVIEW STATUS: PENDING ATTORNEY REVIEW — see
 * docs/regulations-wedge-decision.md.
 */
import { createHash } from "crypto";
import { getDbPool } from "@/utils/db/db-service";
import { ensureRegulationsSchema } from "@/utils/db/regulations-schema";
import {
  WEDGE_AGENCY_CONTACTS,
  WEDGE_CORPUS,
  WEDGE_CATEGORIES,
  WEDGE_STATES,
} from "@/utils/regulations/corpus";

// Deterministic UUID (v5-style, sha256-based) so the stable corpus slug maps
// to the same DB id on every seed run.
function deterministicUuid(namespace: string, slug: string): string {
  const hash = createHash("sha256").update(`${namespace}:${slug}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const pairs = WEDGE_STATES.flatMap((state) =>
    WEDGE_CATEGORIES.map((category) => ({ state, category }))
  );

  console.log(
    `Wedge corpus: ${WEDGE_CORPUS.length} rules across ${pairs.length} state×category slots; ` +
      `${WEDGE_AGENCY_CONTACTS.length} agency contacts.`
  );
  for (const { state, category } of pairs) {
    const rules = WEDGE_CORPUS.filter(
      (rule) => rule.state === state && rule.category === category
    );
    const channels = [...new Set(rules.map((rule) => rule.channel))].sort();
    console.log(
      `  ${state} / ${category}: ${rules.length} rules — channels: ${channels.join(", ")}`
    );
  }
  console.log(
    "\nREVIEW STATUS: PENDING ATTORNEY REVIEW (docs/regulations-wedge-decision.md)"
  );
  if (!apply) {
    console.log("\nDry run — pass --apply to load the corpus into the database.");
    return;
  }

  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await ensureRegulationsSchema(client);
    await client.query("BEGIN");
    for (const { state, category } of pairs) {
      await client.query(
        "DELETE FROM regulation_corpus_rules WHERE state = $1 AND category = $2",
        [state, category]
      );
    }
    for (const rule of WEDGE_CORPUS) {
      await client.query(
        `INSERT INTO regulation_corpus_rules
           (id, state, category, channel, decision, conditions, summary,
            citation_url, citation_title, statute_excerpt,
            effective_date, last_verified_at, tier)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)`,
        [
          deterministicUuid("regulation-corpus-rule", rule.id),
          rule.state,
          rule.category,
          rule.channel,
          rule.decision,
          JSON.stringify(rule.conditions),
          rule.summary,
          rule.citation_url,
          rule.citation_title,
          rule.statute_excerpt,
          rule.effective_date,
          rule.last_verified_at,
          rule.tier,
        ]
      );
    }
    await client.query(
      `DELETE FROM regulation_agency_contacts WHERE state = ANY($1::text[])`,
      [[...WEDGE_STATES]]
    );
    for (const contact of WEDGE_AGENCY_CONTACTS) {
      await client.query(
        `INSERT INTO regulation_agency_contacts
           (id, state, category, agency_name, contact_url, phone, email, last_verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE)`,
        [
          deterministicUuid(
            "regulation-agency-contact",
            `${contact.state}-${contact.category ?? "default"}`
          ),
          contact.state,
          contact.category,
          contact.agency_name,
          contact.contact_url,
          contact.phone,
          contact.email,
        ]
      );
    }
    await client.query("COMMIT");
    console.log(
      `\nSeeded ${WEDGE_CORPUS.length} rules and ${WEDGE_AGENCY_CONTACTS.length} agency contacts.`
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
