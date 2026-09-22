/** biome-ignore-all assist/source/useSortedKeys: <> */
import { index, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import { conversations } from "./conversations";
import { leads } from "./leads";

export const schedulingSessionStatus = pgEnum("scheduling_session_status", [
	"active",
	"closed",
	"expired",
]);

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
		status: schedulingSessionStatus().notNull().default("active"),
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
	})
);
