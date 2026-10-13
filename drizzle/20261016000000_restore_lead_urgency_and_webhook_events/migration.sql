-- Repairs two drifts between the Drizzle schema and the reproducible migration history:
--   1. The auto-generated `20261001230517_sticky_magus` migration dropped `leads.urgency`,
--      even though the AI contract and persistence still require it. It is restored here.
--   2. The WhatsApp webhook idempotency work (event table + processing lease columns
--      + partial unique index on messages.externalId) was only present as loose `.sql`
--      files that the folder-based migrator ignores. It is applied here.
-- Statements are idempotent so an already-migrated database and a fresh database converge.

DO $$ BEGIN
	CREATE TYPE "whatsapp_webhook_event_status" AS ENUM('processing', 'processed', 'failed');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"externalId" text NOT NULL UNIQUE,
	"eventType" text NOT NULL,
	"phone" text,
	"conversationId" uuid,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"status" "whatsapp_webhook_event_status" DEFAULT 'processing'::"whatsapp_webhook_event_status" NOT NULL,
	"lastError" text,
	"leaseExpiresAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "urgency" "lead_urgency";
--> statement-breakpoint
ALTER TABLE "whatsapp_webhook_events" ADD COLUMN IF NOT EXISTS "lastError" text;
--> statement-breakpoint
ALTER TABLE "whatsapp_webhook_events" ADD COLUMN IF NOT EXISTS "leaseExpiresAt" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'whatsapp_webhook_events_conversationId_conversations_id_fkey'
	) THEN
		ALTER TABLE "whatsapp_webhook_events"
			ADD CONSTRAINT "whatsapp_webhook_events_conversationId_conversations_id_fkey"
			FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL;
	END IF;
END $$;
--> statement-breakpoint
WITH ranked_messages AS (
	SELECT
		"id",
		ROW_NUMBER() OVER (
			PARTITION BY "externalId"
			ORDER BY "createdAt", "id"
		) AS row_num
	FROM "messages"
	WHERE "externalId" IS NOT NULL
)
DELETE FROM "messages"
WHERE "id" IN (
	SELECT "id"
	FROM ranked_messages
	WHERE row_num > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_external_id_unique_idx" ON "messages" ("externalId") WHERE "externalId" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_webhook_events_conversation_updated_at_idx" ON "whatsapp_webhook_events" ("conversationId","updatedAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_webhook_events_status_created_at_idx" ON "whatsapp_webhook_events" ("status","createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_webhook_events_status_lease_expires_at_idx" ON "whatsapp_webhook_events" ("status","leaseExpiresAt");
