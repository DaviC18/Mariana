import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { consultants } from "./consultants";

export const googleCalendarConnections = pgTable(
	"google_calendar_connections",
	{
		consultantId: uuid()
			.notNull()
			.unique()
			.references(() => consultants.id, {
				onDelete: "cascade",
			}),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		googleAccountEmail: text().notNull(),
		id: uuid().primaryKey().defaultRandom(),
		refreshToken: text().notNull(),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		consultantIdIdx: index("google_calendar_connections_consultant_id_idx").on(
			table.consultantId
		),
	})
);
