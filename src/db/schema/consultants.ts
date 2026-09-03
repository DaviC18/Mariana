/** biome-ignore-all assist/source/useSortedKeys: <> */

import {
	boolean,
	index,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

export const consultants = pgTable(
	"consultants",
	{
		id: uuid().primaryKey().defaultRandom(),
		name: text().notNull(),
		email: text().notNull().unique(),
		calendarId: text().notNull().unique(),
		active: boolean().notNull().default(true),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		activeIdx: index("consultants_active_idx").on(table.active),
	})
);
