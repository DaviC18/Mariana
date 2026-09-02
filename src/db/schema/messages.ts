/** biome-ignore-all assist/source/useSortedKeys: <> */
import {
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

import { conversations } from "./conversations";

export const messageRole = pgEnum("message_role", [
	"user",
	"assistant",
	"system",
]);

export const messages = pgTable(
	"messages",
	{
		id: uuid().primaryKey().defaultRandom(),
		conversationId: uuid()
			.notNull()
			.references(() => conversations.id, {
				onDelete: "cascade",
			}),
		role: messageRole().notNull(),
		content: text().notNull(),
		externalId: text(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		conversationCreatedAtIdx: index("messages_conversation_created_at_idx").on(
			table.conversationId,
			table.createdAt
		),
		externalIdIdx: index("messages_external_id_idx").on(table.externalId),
	})
);
