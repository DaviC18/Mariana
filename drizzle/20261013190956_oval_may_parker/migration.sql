-- Phase 3: scheduling_session_workflow_stage enum and new columns
DO $$ BEGIN
	CREATE TYPE "scheduling_session_workflow_stage" AS ENUM(
		'awaiting_availability',
		'awaiting_consultant_preference',
		'awaiting_consultant_selection',
		'awaiting_slot_selection',
		'awaiting_confirmation',
		'completed',
		'cancelled'
	);
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Add preferred_consultant_id column if not exists
DO $$ BEGIN
	ALTER TABLE "scheduling_sessions" ADD COLUMN "preferredConsultantId" uuid;
EXCEPTION
	WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint

-- Add workflowStage column if not exists
DO $$ BEGIN
	ALTER TABLE "scheduling_sessions" ADD COLUMN "workflowStage" "scheduling_session_workflow_stage" DEFAULT 'awaiting_availability'::"scheduling_session_workflow_stage" NOT NULL;
EXCEPTION
	WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint

-- Add FK for preferredConsultantId if not exists
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'scheduling_sessions_preferredConsultantId_consultants_id_fkey'
	) THEN
		ALTER TABLE "scheduling_sessions"
			ADD CONSTRAINT "scheduling_sessions_preferredConsultantId_consultants_id_fkey"
			FOREIGN KEY ("preferredConsultantId") REFERENCES "consultants"("id") ON DELETE SET NULL;
	END IF;
END $$;
--> statement-breakpoint

-- Create index for workflowStage if not exists
CREATE INDEX IF NOT EXISTS "scheduling_sessions_workflow_stage_idx" ON "scheduling_sessions" ("workflowStage");
--> statement-breakpoint

-- Update existing active sessions to have correct workflow stage
UPDATE "scheduling_sessions"
SET "workflowStage" = CASE
	WHEN "selectedSlotId" IS NOT NULL THEN 'awaiting_confirmation'::"scheduling_session_workflow_stage"
	WHEN "preferredConsultantId" IS NOT NULL THEN 'awaiting_consultant_selection'::"scheduling_session_workflow_stage"
	ELSE 'awaiting_consultant_preference'::"scheduling_session_workflow_stage"
END
WHERE "status" = 'active' AND "workflowStage" = 'awaiting_availability'::"scheduling_session_workflow_stage";