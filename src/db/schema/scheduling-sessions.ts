/** biome-ignore-all assist/source/useSortedKeys: <> */
import { sql } from "drizzle-orm";
import {
	index,
	pgEnum,
	pgTable,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

import { consultants } from "./consultants";
import { conversations } from "./conversations";
import { leads } from "./leads";

export const schedulingSessionStatus = pgEnum("scheduling_session_status", [
	"active",
	"closed",
	"expired",
]);

export const schedulingSessionWorkflowStage = pgEnum(
	"scheduling_session_workflow_stage",
	[
		"awaiting_availability",
		"awaiting_consultant_preference",
		"awaiting_consultant_selection",
		"awaiting_slot_selection",
		"awaiting_confirmation",
		"completed",
		"cancelled",
	]
);

export const schedulingSessions = pgTable(
	"scheduling_sessions",
	{
		id: uuid().primaryKey().defaultRandom(),
		leadId: uuid()
			.notNull()
			.references(() => leads.id, {
				onDelete: "restrict",
			}),
		conversationId: uuid()
			.notNull()
			.references(() => conversations.id, {
				onDelete: "cascade",
			}),
		selectedSlotId: uuid(),
		preferredConsultantId: uuid().references(() => consultants.id, {
			onDelete: "set null",
		}),
		status: schedulingSessionStatus().notNull().default("active"),
		workflowStage: schedulingSessionWorkflowStage()
			.notNull()
			.default("awaiting_availability"),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp({ withTimezone: true }).notNull(),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		leadIdIdx: index("scheduling_sessions_lead_id_idx").on(table.leadId),
		conversationIdIdx: index("scheduling_sessions_conversation_id_idx").on(
			table.conversationId
		),
		statusIdx: index("scheduling_sessions_status_idx").on(table.status),
		workflowStageIdx: index("scheduling_sessions_workflow_stage_idx").on(
			table.workflowStage
		),
		selectedSlotIdIdx: index("scheduling_sessions_selected_slot_id_idx").on(
			table.selectedSlotId
		),
		activeLeadUnique: uniqueIndex("scheduling_sessions_one_active_lead_unique")
			.on(table.leadId)
			.where(sql`${table.status} = 'active'`),
	})
);
