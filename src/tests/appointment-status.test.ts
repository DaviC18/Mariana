import assert from "node:assert/strict";
import test from "node:test";

import {
	canTransitionAppointmentStatus,
	occupiesAgenda,
} from "../services/appointments/appointment-status";

test("somente os estados ativos ou legados ocupam a agenda", () => {
	assert.equal(occupiesAgenda("pending_confirmation"), true);
	assert.equal(occupiesAgenda("confirmed"), true);
	assert.equal(occupiesAgenda("scheduled"), true);
	assert.equal(occupiesAgenda("expired"), false);
	assert.equal(occupiesAgenda("cancelled"), false);
	assert.equal(occupiesAgenda("completed"), false);
});

test("transições de appointment preservam o ciclo de vida", () => {
	assert.equal(
		canTransitionAppointmentStatus("pending_confirmation", "confirmed"),
		true
	);
	assert.equal(
		canTransitionAppointmentStatus("pending_confirmation", "expired"),
		true
	);
	assert.equal(canTransitionAppointmentStatus("confirmed", "completed"), true);
	assert.equal(canTransitionAppointmentStatus("expired", "confirmed"), false);
	assert.equal(canTransitionAppointmentStatus("completed", "confirmed"), false);
});
