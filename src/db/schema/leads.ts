/** biome-ignore-all assist/source/useSortedKeys: <> */
import {
	boolean,
	index,
	pgEnum,
	pgTable,
	text,
	timestamp,
	unique,
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

export const leadSource = pgEnum("lead_source", [
	"google_ads",
	"meta_ads",
	"whatsapp",
]);

export const leads = pgTable(
	"leads",
	{
		adGroupId: text(),
		adId: text(),
		adSetId: text(),
		birthDate: timestamp({ withTimezone: true }),
		campaignId: text(),
		commercialApproach: leadCommercialApproach(),
		consortiumType: text(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		currentSituation: text(),
		email: text(),
		gclid: text(),
		id: uuid().primaryKey().defaultRandom(),
		interestedInConsultant: boolean().notNull().default(false),
		name: text().notNull(),
		objective: text(),
		painPoint: text(),
		phone: text().notNull(),
		qualifiedAt: timestamp({ withTimezone: true }),
		source: leadSource().notNull().default("whatsapp"),
		sourceLeadId: text(),
		status: leadStatus().notNull().default("new"),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		phoneIdx: index("leads_phone_idx").on(table.phone),
		sourceLeadUnique: unique("leads_source_source_lead_id_unique").on(
			table.source,
			table.sourceLeadId
		),
		statusIdx: index("leads_status_idx").on(table.status),
	})
);
