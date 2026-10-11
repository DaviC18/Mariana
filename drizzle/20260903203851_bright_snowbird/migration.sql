CREATE TYPE "appointment_status" AS ENUM('scheduled', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "conversation_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "lead_status" AS ENUM('new', 'qualifying', 'qualified', 'scheduled');--> statement-breakpoint
CREATE TYPE "message_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"leadId" uuid NOT NULL,
	"consultantId" uuid NOT NULL,
	"externalEventId" text NOT NULL UNIQUE,
	"startAt" timestamp with time zone NOT NULL,
	"endAt" timestamp with time zone NOT NULL,
	"status" "appointment_status" DEFAULT 'scheduled'::"appointment_status" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consultants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"calendarId" text NOT NULL UNIQUE,
	"active" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"leadId" uuid NOT NULL,
	"startedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "conversation_status" DEFAULT 'active'::"conversation_status" NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"objective" text NOT NULL,
	"consortiumType" text NOT NULL,
	"status" "lead_status" DEFAULT 'new'::"lead_status" NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"conversationId" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"externalId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "appointments_consultant_start_idx" ON "appointments" ("consultantId","startAt");--> statement-breakpoint
CREATE INDEX "appointments_lead_id_idx" ON "appointments" ("leadId");--> statement-breakpoint
CREATE INDEX "appointments_status_idx" ON "appointments" ("status");--> statement-breakpoint
CREATE INDEX "consultants_active_idx" ON "consultants" ("active");--> statement-breakpoint
CREATE INDEX "conversations_lead_id_idx" ON "conversations" ("leadId");--> statement-breakpoint
CREATE INDEX "conversations_status_idx" ON "conversations" ("status");--> statement-breakpoint
CREATE INDEX "leads_phone_idx" ON "leads" ("phone");--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" ("status");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_at_idx" ON "messages" ("conversationId","createdAt");--> statement-breakpoint
CREATE INDEX "messages_external_id_idx" ON "messages" ("externalId");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_leadId_leads_id_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_consultantId_consultants_id_fkey" FOREIGN KEY ("consultantId") REFERENCES "consultants"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_leadId_leads_id_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_conversations_id_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE;