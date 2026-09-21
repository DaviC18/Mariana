import assert from "node:assert/strict";
import test from "node:test";

import { db } from "../../db/connections";
import { consultants } from "../../db/schema/consultants";
import { GoogleCalendarService } from "../../integrations/google-calendar/google-calendar-service";
import { AvailabilityService } from "../../services/calendar/availability";

test("integra GoogleCalendarService com AvailabilityService", async () => {
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

	const busyPeriods = await googleCalendarService.getBusyPeriods(
		[joao.calendarId],
		timeMin,
		timeMax
	);

	const joaoBusyPeriods = busyPeriods[0]?.busy ?? [];

	const availableSlots = availabilityService.getAvailableSlots(
		timeMin,
		timeMax,
		joaoBusyPeriods
	);

	console.log("\nJoão Silva");
	console.log("Períodos ocupados:", joaoBusyPeriods);
	console.log("Slots disponíveis:");

	for (const slot of availableSlots) {
		console.log(`  ${slot.start.toISOString()} → ${slot.end.toISOString()}`);
	}

	assert.ok(Array.isArray(availableSlots));
});
