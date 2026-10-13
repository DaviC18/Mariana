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

import { consultants } from "./consultants";
import { leads } from "./leads";

export const appointmentStatus = pgEnum("appointment_status", [
	"pending_confirmation",
	"confirmed",
	"expired",
	"cancelled",
	"completed",
	"scheduled",
]);

export const appointments = pgTable(
	"appointments",
	{
		id: uuid().primaryKey().defaultRandom(),
		leadId: uuid()
			.notNull()
			.references(() => leads.id, {
				onDelete: "restrict",
			}),
		consultantId: uuid()
			.notNull()
			.references(() => consultants.id, {
				onDelete: "restrict",
			}),
		externalEventId: text().notNull().unique(),
		// Chave de idempotência da operação de negócio que originou o
		// agendamento. Estável entre retries da mesma operação lógica.
		idempotencyKey: text(),
		startAt: timestamp({ withTimezone: true }).notNull(),
		endAt: timestamp({ withTimezone: true }).notNull(),
		status: appointmentStatus().notNull().default("pending_confirmation"),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		consultantStartIdx: index("appointments_consultant_start_idx").on(
			table.consultantId,
			table.startAt
		),
		idempotencyKeyUniqueIdx: uniqueIndex(
			"appointments_idempotency_key_unique_idx"
		)
			.on(table.idempotencyKey)
			.where(sql`${table.idempotencyKey} IS NOT NULL`),
		leadIdIdx: index("appointments_lead_id_idx").on(table.leadId),
		statusIdx: index("appointments_status_idx").on(table.status),
	})
);
