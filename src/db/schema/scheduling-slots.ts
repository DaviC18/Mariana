/** biome-ignore-all assist/source/useSortedKeys: <> */
import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

import { consultants } from "./consultants";
import { schedulingSessions } from "./scheduling-sessions";

export const schedulingSlots = pgTable(
	"scheduling_slots",
	{
		id: uuid().primaryKey().defaultRandom(),
		schedulingSessionId: uuid()
			.notNull()
			.references(() => schedulingSessions.id, { onDelete: "cascade" }),
		position: integer().notNull(),
		consultantId: uuid()
			.notNull()
			.references(() => consultants.id, { onDelete: "restrict" }),
		consultantName: text().notNull(),
		calendarId: text().notNull(),
		startAt: timestamp({ withTimezone: true }).notNull(),
		endAt: timestamp({ withTimezone: true }).notNull(),
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
	},
	(table) => ({
		sessionIdIdx: index("scheduling_slots_session_id_idx").on(
			table.schedulingSessionId
		),
		sessionPositionUnique: unique(
			"scheduling_slots_session_position_unique"
		).on(table.schedulingSessionId, table.position),
		positionPositive: check(
			"scheduling_slots_position_positive_check",
			sql`${table.position} > 0`
		),
		validTimeRange: check(
			"scheduling_slots_valid_time_range_check",
			sql`${table.startAt} < ${table.endAt}`
		),
	})
);
