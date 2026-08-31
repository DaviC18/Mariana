import { pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import { leads } from "./leads";

export const conversationStatus = pgEnum("conversation_status", [
	"active",
	"closed",
]);

export const conversations = pgTable("conversations", {
	id: uuid().primaryKey().defaultRandom(),
	leadId: uuid()
		.notNull()
		.references(() => leads.id, {
			onDelete: "cascade",
		}),
	startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	status: conversationStatus().notNull().default("active"),
	updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
