import { index, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import { leads } from "./leads";

export const conversationStatus = pgEnum("conversation_status", [
	"active",
	"closed",
]);

export const conversations = pgTable(
	"conversations",
	{
		id: uuid().primaryKey().defaultRandom(),
		// Operational WhatsApp compliance state. This is intentionally separate
		// from the agent's reasoning and qualification state.
		lastCustomerMessageAt: timestamp({ withTimezone: true }),
		leadId: uuid()
			.notNull()
			.references(() => leads.id, {
				onDelete: "cascade",
			}),
		optOutAt: timestamp({ withTimezone: true }),
		startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		status: conversationStatus().notNull().default("active"),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		leadIdIdx: index("conversations_lead_id_idx").on(table.leadId),
		statusIdx: index("conversations_status_idx").on(table.status),
	})
);
