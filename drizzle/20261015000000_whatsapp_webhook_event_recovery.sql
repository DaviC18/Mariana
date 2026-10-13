ALTER TABLE "whatsapp_webhook_events"
  ADD COLUMN IF NOT EXISTS "lastError" text,
  ADD COLUMN IF NOT EXISTS "leaseExpiresAt" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "whatsapp_webhook_events_status_lease_expires_at_idx"
  ON "whatsapp_webhook_events" ("status", "leaseExpiresAt");
