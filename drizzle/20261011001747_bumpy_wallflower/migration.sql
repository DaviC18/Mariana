CREATE TYPE "autonomous_task_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "autonomous_tasks" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"availableAt" timestamp with time zone DEFAULT now() NOT NULL,
	"completedAt" timestamp with time zone,
	"conversationId" uuid NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"idempotencyKey" text NOT NULL UNIQUE,
	"lastError" text,
	"lockedAt" timestamp with time zone,
	"maxAttempts" integer DEFAULT 5 NOT NULL,
	"maxSteps" integer DEFAULT 8 NOT NULL,
	"payload" jsonb DEFAULT '{}' NOT NULL,
	"result" jsonb,
	"startedAt" timestamp with time zone,
	"status" "autonomous_task_status" DEFAULT 'pending'::"autonomous_task_status" NOT NULL,
	"stepNumber" integer DEFAULT 0 NOT NULL,
	"taskType" text NOT NULL,
	"triggerMessageId" uuid NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"workflowId" uuid DEFAULT gen_random_uuid() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "autonomous_tasks_conversation_created_at_idx" ON "autonomous_tasks" ("conversationId","createdAt");--> statement-breakpoint
CREATE INDEX "autonomous_tasks_status_available_at_idx" ON "autonomous_tasks" ("status","availableAt");--> statement-breakpoint
CREATE INDEX "autonomous_tasks_workflow_step_idx" ON "autonomous_tasks" ("workflowId","stepNumber");--> statement-breakpoint
ALTER TABLE "autonomous_tasks" ADD CONSTRAINT "autonomous_tasks_conversationId_conversations_id_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "autonomous_tasks" ADD CONSTRAINT "autonomous_tasks_triggerMessageId_messages_id_fkey" FOREIGN KEY ("triggerMessageId") REFERENCES "messages"("id") ON DELETE CASCADE;