import type { PoolClient } from "pg";

// Keep the standalone db/schema.sql block byte-for-byte in sync. The real
// Postgres integration suite verifies both install paths use the same DDL.
export const MOBILE_NOTIFICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS mobile_notification_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_pubkey TEXT NOT NULL CHECK (seller_pubkey ~ '^[0-9a-f]{64}$'),
  installation_id UUID NOT NULL,
  deployment TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios','android')),
  token_ciphertext TEXT NOT NULL,
  token_digest TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '5 minutes',
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mobile_challenges_expiry ON mobile_notification_challenges(expires_at);

CREATE TABLE IF NOT EXISTS mobile_push_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_pubkey TEXT NOT NULL CHECK (seller_pubkey ~ '^[0-9a-f]{64}$'),
  installation_id UUID NOT NULL,
  deployment TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios','android')),
  token_ciphertext TEXT NOT NULL,
  token_digest TEXT NOT NULL,
  revocation_hash TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  enabled BOOLEAN NOT NULL DEFAULT true,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sent_at TIMESTAMPTZ,
  UNIQUE (installation_id, deployment)
);
ALTER TABLE mobile_push_devices ADD COLUMN IF NOT EXISTS send_attempts_at TIMESTAMPTZ[] NOT NULL DEFAULT '{}';
ALTER TABLE mobile_push_devices ADD COLUMN IF NOT EXISTS covered_activity_at TIMESTAMPTZ;
ALTER TABLE mobile_push_devices ADD COLUMN IF NOT EXISTS covered_activity_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_active_token ON mobile_push_devices(deployment, token_digest) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_mobile_devices_seller ON mobile_push_devices(seller_pubkey, deployment);

CREATE TABLE IF NOT EXISTS mobile_notification_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id TEXT NOT NULL,
  recipient_pubkey TEXT NOT NULL CHECK (recipient_pubkey ~ '^[0-9a-f]{64}$'),
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, recipient_pubkey)
);
CREATE INDEX IF NOT EXISTS idx_mobile_activity_recipient ON mobile_notification_activity(recipient_pubkey, ingested_at);

CREATE TABLE IF NOT EXISTS mobile_push_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id UUID NOT NULL REFERENCES mobile_notification_activity(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES mobile_push_devices(id) ON DELETE CASCADE,
  binding_generation INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','accepted','provider_accepted','retry_wait','invalid_device','failed','expired','superseded')),
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  ticket_id TEXT,
  receipt_due_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  UNIQUE (activity_id, device_id, binding_generation)
);
CREATE INDEX IF NOT EXISTS idx_mobile_deliveries_due ON mobile_push_deliveries(status, due_at);
CREATE INDEX IF NOT EXISTS idx_mobile_receipts_due ON mobile_push_deliveries(receipt_due_at) WHERE status='accepted';

CREATE OR REPLACE FUNCTION capture_mobile_message_activity() RETURNS trigger AS $$
DECLARE recipients TEXT[];
BEGIN
  IF NEW.kind <> 1059 OR jsonb_typeof(NEW.tags) IS DISTINCT FROM 'array' THEN
    RETURN NEW;
  END IF;
  SELECT array_agg(DISTINCT tag->>1) INTO recipients
  FROM jsonb_array_elements(NEW.tags) tag
  WHERE tag->>0='p' AND tag->>1 ~ '^[0-9a-f]{64}$';
  IF cardinality(recipients)=1 THEN
    INSERT INTO mobile_notification_activity(message_id,recipient_pubkey)
    VALUES (NEW.id,recipients[1]) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='capture_mobile_message_activity_insert' AND tgrelid='message_events'::regclass) THEN
    CREATE TRIGGER capture_mobile_message_activity_insert
    AFTER INSERT ON message_events FOR EACH ROW EXECUTE FUNCTION capture_mobile_message_activity();
  END IF;
END $$;
`;

export async function ensureMobileNotificationSchema(
  client: PoolClient
): Promise<void> {
  await client.query(MOBILE_NOTIFICATION_SCHEMA);
}
