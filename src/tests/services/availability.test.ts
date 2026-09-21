import assert from "node:assert/strict";
import test from "node:test";

import { AvailabilityService } from "../../services/calendar/availability";

const service = new AvailabilityService();

test("gera slots de 30 minutos quando não existem conflitos", () => {
	const timeMin = new Date("2026-09-19T09:00:00-03:00");
	const timeMax = new Date("2026-09-19T11:00:00-03:00");

	const slots = service.getAvailableSlots(timeMin, timeMax, []);

	assert.equal(slots.length, 4);

	assert.deepEqual(
		slots.map((slot) => ({
			end: slot.end.toISOString(),
			start: slot.start.toISOString(),
		})),
		[
			{
				end: "2026-09-19T12:30:00.000Z",
				start: "2026-09-19T12:00:00.000Z",
			},
			{
				end: "2026-09-19T13:00:00.000Z",
				start: "2026-09-19T12:30:00.000Z",
			},
			{
				end: "2026-09-19T13:30:00.000Z",
				start: "2026-09-19T13:00:00.000Z",
			},
			{
				end: "2026-09-19T14:00:00.000Z",
				start: "2026-09-19T13:30:00.000Z",
			},
		]
	);
});

test("remove slots que entram em conflito com períodos ocupados", () => {
	const timeMin = new Date("2026-09-19T09:00:00-03:00");
	const timeMax = new Date("2026-09-19T11:00:00-03:00");

	const busyPeriods = [
		{
			end: "2026-09-19T10:30:00-03:00",
			start: "2026-09-19T09:30:00-03:00",
		},
	];

	const slots = service.getAvailableSlots(timeMin, timeMax, busyPeriods);

	assert.deepEqual(
		slots.map((slot) => ({
			end: slot.end.toISOString(),
			start: slot.start.toISOString(),
		})),
		[
			{
				end: "2026-09-19T12:30:00.000Z",
				start: "2026-09-19T12:00:00.000Z",
			},
			{
				end: "2026-09-19T14:00:00.000Z",
				start: "2026-09-19T13:30:00.000Z",
			},
		]
	);
});

test("não considera conflito quando o evento começa exatamente no fim do slot", () => {
	const timeMin = new Date("2026-09-19T09:00:00-03:00");
	const timeMax = new Date("2026-09-19T10:00:00-03:00");

	const busyPeriods = [
		{
			end: "2026-09-19T10:00:00-03:00",
			start: "2026-09-19T09:30:00-03:00",
		},
	];

	const slots = service.getAvailableSlots(timeMin, timeMax, busyPeriods);

	assert.equal(slots.length, 1);

	assert.equal(slots[0]?.start.toISOString(), "2026-09-19T12:00:00.000Z");

	assert.equal(slots[0]?.end.toISOString(), "2026-09-19T12:30:00.000Z");
});
