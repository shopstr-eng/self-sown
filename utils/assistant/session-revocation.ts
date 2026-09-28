/**
 * Per-seller revocation stamps for the assistant session tokens.
 *
 * The tokens are stateless HMAC: once minted they verify until their TTL no
 * matter what, and rotating SESSION_SECRET kills EVERY seller's tokens at
 * once. A seller who suspects a token leaked (shared screen, borrowed
 * laptop) needs a targeted kill switch, so each seller has a "revoked
 * before <ts>" stamp: the bearer preamble (session-auth.ts) rejects any
 * token whose issued-at is at or before the stamp.
 *
 * The stamp lives in the shared pro_settings key/value table — no new
 * schema, and it survives restarts and is visible to every server instance
 * (unlike an in-memory denylist, which would miss tokens verified by other
 * instances).
 *
 * DB posture (see the null-vs-outage rule): a lookup ERROR throws — the
 * caller fails closed and rejects the request rather than waving a possibly
 * revoked token through during an outage. Only a genuinely absent stamp
 * reads as null ("nothing revoked").
 */
import { getDbPool } from "@/utils/db/db-service";
import { getProSetting } from "@/utils/db/pro-membership";

const HEX64 = /^[0-9a-f]{64}$/;
const STAMP_KEY_PREFIX = "assistant_session_revoked_before:";

function stampKey(pubkey: string): string {
  if (!HEX64.test(pubkey)) {
    throw new Error("Invalid pubkey for session revocation stamp");
  }
  return `${STAMP_KEY_PREFIX}${pubkey}`;
}

/**
 * The seller's revocation stamp (epoch ms), or null when they have never
 * revoked. Throws on DB error — never swallow an outage as "not revoked".
 */
export async function getAssistantSessionRevokedBefore(
  pubkey: string
): Promise<number | null> {
  const raw = await getProSetting(stampKey(pubkey));
  if (raw === null) return null;
  const ts = Number(raw);
  // A corrupt stamp must not silently disable revocation OR lock the seller
  // out forever; treat it as absent so the seller can still re-revoke.
  if (!Number.isInteger(ts) || ts <= 0) return null;
  return ts;
}

/**
 * Invalidate every session token this seller holds that was issued at or
 * before `revokedBeforeMs` (default: now). Returns the persisted stamp.
 *
 * The stamp advances in ONE atomic upsert with GREATEST — never a
 * read-modify-write. Two concurrent DELETEs must be monotonic: if an older
 * request read first but wrote last, it would overwrite a newer stamp with
 * an earlier timestamp and silently re-validate tokens the newer DELETE
 * (already reported successful) had killed. A corrupt non-numeric stamp
 * folds to 0 so it can never wedge the kill switch.
 */
export async function revokeAssistantSessions(
  pubkey: string,
  revokedBeforeMs: number = Date.now()
): Promise<number> {
  const stamped = String(Math.floor(revokedBeforeMs));
  let client;
  try {
    client = await getDbPool().connect();
    const result = await client.query(
      `INSERT INTO pro_settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE
         SET value = GREATEST(
               CASE WHEN pro_settings.value ~ '^[0-9]+$'
                 THEN pro_settings.value::bigint
                 ELSE 0
               END,
               EXCLUDED.value::bigint
             )::text,
             updated_at = now()
       RETURNING value`,
      [stampKey(pubkey), stamped]
    );
    const persisted = Number(result.rows[0]?.value ?? stamped);
    return Number.isInteger(persisted) && persisted > 0
      ? persisted
      : Math.floor(revokedBeforeMs);
  } finally {
    if (client) client.release();
  }
}
