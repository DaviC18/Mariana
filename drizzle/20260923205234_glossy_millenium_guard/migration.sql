CREATE TABLE "scheduling_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"schedulingSessionId" uuid NOT NULL,
	"position" integer NOT NULL,
	"consultantId" uuid NOT NULL,
	"consultantName" text NOT NULL,
	"calendarId" text NOT NULL,
	"startAt" timestamp with time zone NOT NULL,
	"endAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduling_slots_session_position_unique" UNIQUE("schedulingSessionId","position"),
	CONSTRAINT "scheduling_slots_position_positive_check" CHECK ("position" > 0),
	CONSTRAINT "scheduling_slots_valid_time_range_check" CHECK ("startAt" < "endAt")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "scheduling_sessions_one_active_lead_unique" ON "scheduling_sessions" ("leadId") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "scheduling_slots_session_id_idx" ON "scheduling_slots" ("schedulingSessionId");--> statement-breakpoint
ALTER TABLE "scheduling_slots" ADD CONSTRAINT "scheduling_slots_OTG3cqIHDlJr_fkey" FOREIGN KEY ("schedulingSessionId") REFERENCES "scheduling_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scheduling_slots" ADD CONSTRAINT "scheduling_slots_consultantId_consultants_id_fkey" FOREIGN KEY ("consultantId") REFERENCES "consultants"("id") ON DELETE RESTRICT;