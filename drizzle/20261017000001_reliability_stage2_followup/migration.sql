-- Stage 2 follow-up: correct two design issues found during implementation.
--
-- 1. The partial unique index on (conversationId) WHERE status='pending'
--    would silently drop distinct pending events (e.g. a button reply arriving
--    while a text task is pending). Ordering is already guaranteed by the
--    executor's NOT EXISTS clause, so the index is removed.
--
-- 2. autonomous_tasks.triggerMessageId must be nullable: button replies do not
--    produce an inbound message row.

DROP INDEX IF EXISTS "autonomous_tasks_pending_conversation_unique";
--> statement-breakpoint
ALTER TABLE "autonomous_tasks" ALTER COLUMN "triggerMessageId" DROP NOT NULL;
