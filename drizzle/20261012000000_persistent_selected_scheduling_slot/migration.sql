ALTER TABLE "scheduling_sessions" ADD COLUMN "selectedSlotId" uuid;--> statement-breakpoint
ALTER TABLE "scheduling_sessions" ADD CONSTRAINT "scheduling_sessions_selectedSlotId_scheduling_slots_id_fkey" FOREIGN KEY ("selectedSlotId") REFERENCES "scheduling_slots"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX "scheduling_sessions_selected_slot_id_idx" ON "scheduling_sessions" ("selectedSlotId");
