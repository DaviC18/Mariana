/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all lint/suspicious/noUnusedExpressions: <> */

import assert from "node:assert/strict";
import test from "node:test";

import { closeDatabase, db } from "../../db/connections";
import { consultants } from "../../db/schema/consultants";
import { GoogleCalendarService } from "../../integrations/google-calendar/google-calendar-service";
import { AvailabilityService } from "../../services/calendar/availability";

test.after(async () => {
	await closeDatabase();
});

test("usa GoogleCalendarService mockado com AvailabilityService", async (t) => {
	const consultantRows = await db
		.select({
			calendarId: consultants.calendarId,
			name: consultants.name,
		})
		.from(consultants);

	assert.ok(consultantRows.length >= 3);

	const joao = consultantRows.find(
		(consultant) => consultant.name === "João Silva"
	);

	const maria = consultantRows.find(
		(consultant) => consultant.name === "Maria Souza"
	);

	const carlos = consultantRows.find(
		(consultant) => consultant.name === "Carlos Oliveira"
	);

	assert.ok(joao);
	assert.ok(maria);
	assert.ok(carlos);

	const timeMin = new Date("2026-09-19T16:00:00-03:00");
	const timeMax = new Date("2026-09-19T18:00:00-03:00");

	const googleCalendarService = new GoogleCalendarService();
	const availabilityService = new AvailabilityService();

	t.mock.method(googleCalendarService, "getBusyPeriods", async () => [
		{
			busy: [],
			calendarId: joao.calendarId,
		},
	]);

	const busyPeriods = await googleCalendarService.getBusyPeriods(
		[joao.calendarId],
		timeMin,
		timeMax
	);

	assert.equal(busyPeriods.length, 1);
	assert.equal(busyPeriods[0]?.calendarId, joao.calendarId);
	assert.equal(busyPeriods[0]?.busy.length, 0);

	const joaoBusyPeriods = busyPeriods[0]?.busy ?? [];

	const availableSlots = availabilityService.getAvailableSlots(
		timeMin,
		timeMax,
		joaoBusyPeriods
	);

	assert.ok(Array.isArray(availableSlots));

	console.log("\nJoão Silva");
	console.log("Períodos ocupados:", joaoBusyPeriods);
	console.log("Slots disponíveis:");

	for (const slot of availableSlots) {
		console.log(`  ${slot.start.toISOString()} → ${slot.end.toISOString()}`);
	}
});
