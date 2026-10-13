/** biome-ignore-all assist/source/useSortedKeys: <> */
import { sql } from "drizzle-orm";
import {
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
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
		// Marca quando a mensagem de entrada foi efetivamente processada pelo
		// worker durável. Mensagens com processedAt nulo ainda precisam de
		// processamento e são recuperadas após restart.
		processedAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		conversationCreatedAtIdx: index("messages_conversation_created_at_idx").on(
			table.conversationId,
			table.createdAt
		),
		conversationUnprocessedIdx: index("messages_conversation_unprocessed_idx")
			.on(table.conversationId, table.createdAt)
			.where(sql`${table.processedAt} IS NULL`),
		externalIdIdx: index("messages_external_id_idx").on(table.externalId),
		externalIdUniqueIdx: uniqueIndex("messages_external_id_unique_idx")
			.on(table.externalId)
			.where(sql`"externalId" IS NOT NULL`),
	})
);
