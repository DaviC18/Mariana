import assert from "node:assert/strict";
import test from "node:test";

import { AvailabilityService } from "../../services/calendar/availability";

test("gera horário comercial de segunda a sexta", () => {
	const service = new AvailabilityService();

	const timeMin = new Date("2026-09-21T00:00:00-03:00");
	const timeMax = new Date("2026-09-25T23:59:59-03:00");

	const businessHours = service.getBusinessHours(timeMin, timeMax);

	assert.equal(businessHours.length, 5);

	for (const period of businessHours) {
		assert.equal(period.start.getHours(), 8);
		assert.equal(period.end.getHours(), 18);
	}
});

test("não gera horário comercial no sábado e domingo", () => {
	const service = new AvailabilityService();

	const timeMin = new Date("2026-09-19T00:00:00-03:00");
	const timeMax = new Date("2026-09-20T23:59:59-03:00");

	const businessHours = service.getBusinessHours(timeMin, timeMax);

	assert.equal(businessHours.length, 0);
});
