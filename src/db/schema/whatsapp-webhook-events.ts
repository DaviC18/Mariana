/** biome-ignore-all assist/source/useSortedKeys: <> */
import {
	index,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

import { conversations } from "./conversations";

export const whatsappWebhookEventStatus = pgEnum(
	"whatsapp_webhook_event_status",
	["processing", "processed", "failed"]
);

export const whatsappWebhookEvents = pgTable(
	"whatsapp_webhook_events",
	{
		id: uuid().primaryKey().defaultRandom(),
		externalId: text().notNull().unique(),
		eventType: text().notNull(),
		phone: text(),
		conversationId: uuid().references(() => conversations.id, {
			onDelete: "set null",
		}),
		payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		status: whatsappWebhookEventStatus().notNull().default("processing"),
		lastError: text(),
		leaseExpiresAt: timestamp({ withTimezone: true }),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		conversationUpdatedAtIdx: index(
			"whatsapp_webhook_events_conversation_updated_at_idx"
		).on(table.conversationId, table.updatedAt),
		statusCreatedAtIdx: index(
			"whatsapp_webhook_events_status_created_at_idx"
		).on(table.status, table.createdAt),
		statusLeaseExpiresAtIdx: index(
			"whatsapp_webhook_events_status_lease_expires_at_idx"
		).on(table.status, table.leaseExpiresAt),
	})
);
