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

export const leadUrgency = pgEnum("lead_urgency", [
	"immediate",
	"short_term",
	"medium_term",
	"long_term",
]);

export const leadCommercialApproach = pgEnum("lead_commercial_approach", [
	"vehicle_renewal",
	"operational_cost",
	"cash_purchase_power",
	"investment_discipline",
	"quota_bank",
	"fleet",
	"general",
]);

export const leads = pgTable(
	"leads",
	{
		id: uuid().primaryKey().defaultRandom(),
		name: text().notNull(),
		phone: text().notNull(),
		objective: text().notNull(),
		consortiumType: text().notNull(),
		painPoint: text(),
		urgency: leadUrgency(),
		currentSituation: text(),
		commercialApproach: leadCommercialApproach(),
		qualifiedAt: timestamp({ withTimezone: true }),
		status: leadStatus().notNull().default("new"),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		phoneIdx: index("leads_phone_idx").on(table.phone),
		statusIdx: index("leads_status_idx").on(table.status),
	})
);
