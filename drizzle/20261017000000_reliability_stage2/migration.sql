-- Stage 2: WhatsApp reliability and fault-tolerant processing.
--
-- Adds:
--   1. Lease ownership to autonomous_tasks (token + expiry) plus a partial
--      unique index that serializes pending work per conversation.
--   2. A durable processing marker on inbound messages (processedAt).
--   3. A business idempotency key on appointments.
--   4. A PostgreSQL-backed outbound message outbox.
--
-- Statements are idempotent so a fresh database and an already-migrated
-- database converge to the same schema.

-- 1. autonomous_tasks: lease ownership.
ALTER TABLE "autonomous_tasks" ADD COLUMN IF NOT EXISTS "leaseToken" uuid;
--> statement-breakpoint
ALTER TABLE "autonomous_tasks" ADD COLUMN IF NOT EXISTS "leaseExpiresAt" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "autonomous_tasks_status_lease_expires_at_idx" ON "autonomous_tasks" ("status","leaseExpiresAt");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "autonomous_tasks_pending_conversation_unique" ON "autonomous_tasks" ("conversationId") WHERE "status" = 'pending';
--> statement-breakpoint

-- 2. messages: durable processing marker.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "processedAt" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_conversation_unprocessed_idx" ON "messages" ("conversationId","createdAt") WHERE "processedAt" IS NULL;
--> statement-breakpoint

-- 3. appointments: business idempotency key.
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "idempotencyKey" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "appointments_idempotency_key_unique_idx" ON "appointments" ("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
--> statement-breakpoint

-- 4. outbound outbox.
DO $$ BEGIN
	CREATE TYPE "outbound_message_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'unknown');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"idempotencyKey" text NOT NULL UNIQUE,
	"conversationId" uuid NOT NULL,
	"leadId" uuid,
	"eventId" uuid,
	"messageId" uuid,
	"messageType" text NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"status" "outbound_message_status" DEFAULT 'pending'::"outbound_message_status" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"maxAttempts" integer DEFAULT 5 NOT NULL,
	"availableAt" timestamp with time zone DEFAULT now() NOT NULL,
	"leaseToken" uuid,
	"leaseExpiresAt" timestamp with time zone,
	"providerMessageId" text,
	"lastError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"sentAt" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'outbound_messages_conversationId_conversations_id_fkey'
	) THEN
		ALTER TABLE "outbound_messages"
			ADD CONSTRAINT "outbound_messages_conversationId_conversations_id_fkey"
			FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'outbound_messages_leadId_leads_id_fkey'
	) THEN
		ALTER TABLE "outbound_messages"
			ADD CONSTRAINT "outbound_messages_leadId_leads_id_fkey"
			FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'outbound_messages_eventId_whatsapp_webhook_events_id_fkey'
	) THEN
		ALTER TABLE "outbound_messages"
			ADD CONSTRAINT "outbound_messages_eventId_whatsapp_webhook_events_id_fkey"
			FOREIGN KEY ("eventId") REFERENCES "whatsapp_webhook_events"("id") ON DELETE SET NULL;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'outbound_messages_messageId_messages_id_fkey'
	) THEN
		ALTER TABLE "outbound_messages"
			ADD CONSTRAINT "outbound_messages_messageId_messages_id_fkey"
			FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_messages_conversation_created_at_idx" ON "outbound_messages" ("conversationId","createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_messages_status_available_at_idx" ON "outbound_messages" ("status","availableAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_messages_status_lease_expires_at_idx" ON "outbound_messages" ("status","leaseExpiresAt");
