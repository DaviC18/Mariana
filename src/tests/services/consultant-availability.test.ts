/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useDestructuring: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */

import assert from "node:assert/strict";
import test from "node:test";

import { closeDatabase, db } from "../../db/connections";
import { consultants as consultantsTable } from "../../db/schema/consultants";
import { GoogleCalendarService } from "../../integrations/google-calendar/google-calendar-service";
import { ConsultantAvailabilityService } from "../../services/calendar/consultant-availability";

type GetBusyPeriods = GoogleCalendarService["getBusyPeriods"];
type GetBusyPeriodsCalendarIds = Parameters<GetBusyPeriods>[0];
type GetBusyPeriodsDate = Parameters<GetBusyPeriods>[1];

test.after(async () => {
	await closeDatabase();
});

test("seleciona o primeiro consultor disponível para cada horário", async (t) => {
	const consultantRows = await db
		.select({
			calendarId: consultantsTable.calendarId,
			id: consultantsTable.id,
			name: consultantsTable.name,
		})
		.from(consultantsTable);

	const consultants = consultantRows.sort((a, b) => {
		const order = ["João Silva", "Maria Souza", "Carlos Oliveira"];

		return order.indexOf(a.name) - order.indexOf(b.name);
	});

	assert.equal(consultants.length, 3);

	const joao = consultants.find(
		(consultant) => consultant.name === "João Silva"
	);

	const maria = consultants.find(
		(consultant) => consultant.name === "Maria Souza"
	);

	const carlos = consultants.find(
		(consultant) => consultant.name === "Carlos Oliveira"
	);

	assert.ok(joao);
	assert.ok(maria);
	assert.ok(carlos);

	const timeMin = new Date("2026-09-21T16:30:00-03:00");
	const timeMax = new Date("2026-09-21T18:00:00-03:00");

	const googleCalendarService = new GoogleCalendarService();

	t.mock.method(
		googleCalendarService,
		"getBusyPeriods",
		async (
			calendarIds: GetBusyPeriodsCalendarIds,
			start: GetBusyPeriodsDate,
			_end: GetBusyPeriodsDate
		) => {
			await Promise.resolve();

			const calendarId = calendarIds[0];

			if (calendarId === joao.calendarId) {
				const firstSlotEnd = new Date(start);
				firstSlotEnd.setMinutes(firstSlotEnd.getMinutes() + 30);

				return [
					{
						busy: [
							{
								end: firstSlotEnd.toISOString(),
								start: start.toISOString(),
							},
						],
						calendarId,
					},
				];
			}

			return [
				{
					busy: [],
					calendarId,
				},
			];
		}
	);

	const service = new ConsultantAvailabilityService(googleCalendarService);

	const availableSlots = await service.getAvailableConsultants(
		consultants,
		timeMin,
		timeMax
	);

	console.log("\nSlots atribuídos:");

	for (const slot of availableSlots) {
		console.log(
			`  ${slot.start.toISOString()} → ${slot.end.toISOString()} | ${slot.consultant.name}`
		);
	}

	assert.ok(availableSlots.length > 0);

	const occupiedSlot = availableSlots.find(
		(slot) =>
			slot.start.getTime() === timeMin.getTime() &&
			slot.consultant.id === joao.id
	);

	assert.equal(occupiedSlot, undefined);

	const firstSlot = availableSlots.find(
		(slot) => slot.start.getTime() === timeMin.getTime()
	);

	assert.ok(firstSlot);

	assert.equal(firstSlot.consultant.name, "Maria Souza");
});

test("retorna vazio quando não existem consultores", async () => {
	const service = new ConsultantAvailabilityService();

	const timeMin = new Date("2026-09-21T16:30:00-03:00");
	const timeMax = new Date("2026-09-21T18:00:00-03:00");

	const availableSlots = await service.getAvailableConsultants(
		[],
		timeMin,
		timeMax
	);

	assert.deepEqual(availableSlots, []);
});
