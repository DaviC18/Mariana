CREATE TYPE "scheduling_session_status" AS ENUM('active', 'closed', 'expired');--> statement-breakpoint
CREATE TABLE "scheduling_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"leadId" uuid NOT NULL,
	"conversationId" uuid NOT NULL,
	"status" "scheduling_session_status" DEFAULT 'active'::"scheduling_session_status" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
--> statement-breakpoint
CREATE INDEX "scheduling_sessions_lead_id_idx" ON "scheduling_sessions" ("leadId");--> statement-breakpoint
CREATE INDEX "scheduling_sessions_conversation_id_idx" ON "scheduling_sessions" ("conversationId");--> statement-breakpoint
CREATE INDEX "scheduling_sessions_status_idx" ON "scheduling_sessions" ("status");--> statement-breakpoint
ALTER TABLE "scheduling_sessions" ADD CONSTRAINT "scheduling_sessions_leadId_leads_id_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "scheduling_sessions" ADD CONSTRAINT "scheduling_sessions_conversationId_conversations_id_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE;