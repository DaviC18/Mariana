CREATE TYPE "outbound_message_status" AS ENUM('pending', 'sending', 'sent', 'failed', 'unknown');--> statement-breakpoint
CREATE TABLE "outbound_messages" (
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
ALTER TABLE "scheduling_sessions" DROP CONSTRAINT "scheduling_sessions_selectedSlotId_scheduling_slots_id_fkey";--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "idempotencyKey" text;--> statement-breakpoint
ALTER TABLE "autonomous_tasks" ADD COLUMN "leaseExpiresAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "autonomous_tasks" ADD COLUMN "leaseToken" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "processedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scheduling_sessions" ADD COLUMN "preferredConsultantId" uuid;--> statement-breakpoint
ALTER TABLE "scheduling_sessions" ADD COLUMN "workflowStage" "scheduling_session_workflow_stage" DEFAULT 'awaiting_availability'::"scheduling_session_workflow_stage" NOT NULL;--> statement-breakpoint
ALTER TABLE "autonomous_tasks" ALTER COLUMN "triggerMessageId" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_idempotency_key_unique_idx" ON "appointments" ("idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "autonomous_tasks_status_lease_expires_at_idx" ON "autonomous_tasks" ("status","leaseExpiresAt");--> statement-breakpoint
CREATE INDEX "messages_conversation_unprocessed_idx" ON "messages" ("conversationId","createdAt") WHERE "processedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "outbound_messages_conversation_created_at_idx" ON "outbound_messages" ("conversationId","createdAt");--> statement-breakpoint
CREATE INDEX "outbound_messages_status_available_at_idx" ON "outbound_messages" ("status","availableAt");--> statement-breakpoint
CREATE INDEX "outbound_messages_status_lease_expires_at_idx" ON "outbound_messages" ("status","leaseExpiresAt");--> statement-breakpoint
CREATE INDEX "scheduling_sessions_workflow_stage_idx" ON "scheduling_sessions" ("workflowStage");--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_conversationId_conversations_id_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_leadId_leads_id_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_eventId_whatsapp_webhook_events_id_fkey" FOREIGN KEY ("eventId") REFERENCES "whatsapp_webhook_events"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_messageId_messages_id_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "scheduling_sessions" ADD CONSTRAINT "scheduling_sessions_preferredConsultantId_consultants_id_fkey" FOREIGN KEY ("preferredConsultantId") REFERENCES "consultants"("id") ON DELETE SET NULL;