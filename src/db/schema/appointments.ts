/** biome-ignore-all assist/source/useSortedKeys: <> */
import {
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

import { consultants } from "./consultants";
import { leads } from "./leads";

export const appointmentStatus = pgEnum("appointment_status", [
	"scheduled",
	"cancelled",
	"completed",
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
		startAt: timestamp({ withTimezone: true }).notNull(),
		endAt: timestamp({ withTimezone: true }).notNull(),
		status: appointmentStatus().notNull().default("scheduled"),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		consultantStartIdx: index("appointments_consultant_start_idx").on(
			table.consultantId,
			table.startAt
		),
		leadIdIdx: index("appointments_lead_id_idx").on(table.leadId),
		statusIdx: index("appointments_status_idx").on(table.status),
	})
);
