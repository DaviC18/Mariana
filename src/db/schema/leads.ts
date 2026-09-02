/** biome-ignore-all assist/source/useSortedKeys: <> */
import {
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

export const leadStatus = pgEnum("lead_status", [
	"new",
	"qualifying",
	"qualified",
	"scheduled",
]);

export const leads = pgTable(
	"leads",
	{
		id: uuid().primaryKey().defaultRandom(),
		name: text().notNull(),
		phone: text().notNull(),
		objective: text().notNull(),
		consortiumType: text().notNull(),
		status: leadStatus().notNull().default("new"),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		phoneIdx: index("leads_phone_idx").on(table.phone),
		statusIdx: index("leads_status_idx").on(table.status),
	})
);
