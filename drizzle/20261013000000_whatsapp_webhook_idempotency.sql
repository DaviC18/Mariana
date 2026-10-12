CREATE TYPE "whatsapp_webhook_event_status" AS ENUM ('processing', 'processed', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "whatsapp_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"externalId" text NOT NULL,
	"eventType" text NOT NULL,
	"phone" text,
	"conversationId" uuid,
	"payload" jsonb NOT NULL DEFAULT '{}',
	"status" "whatsapp_webhook_event_status" NOT NULL DEFAULT 'processing',
	"createdAt" timestamp with time zone NOT NULL DEFAULT now(),
	"updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "whatsapp_webhook_events_conversationId_conversations_id_fk" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_webhook_events_external_id_idx" ON "whatsapp_webhook_events" ("externalId");--> statement-breakpoint
CREATE INDEX "whatsapp_webhook_events_conversation_updated_at_idx" ON "whatsapp_webhook_events" ("conversationId", "updatedAt");--> statement-breakpoint
CREATE INDEX "whatsapp_webhook_events_status_created_at_idx" ON "whatsapp_webhook_events" ("status", "createdAt");--> statement-breakpoint
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
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "messages_external_id_unique_idx" ON "messages" ("externalId") WHERE "externalId" IS NOT NULL;
