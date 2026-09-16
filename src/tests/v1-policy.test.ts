import assert from "node:assert/strict";
import test from "node:test";

import { isConfirmedAppointmentStatus } from "../services/appointments/appointment-status";
import { createAvailabilityWaitlist } from "../services/availability/waitlist";
import { findMentorWithLowestLoad } from "../services/consultants/consultant-load";
import { isGuardrailHit } from "../services/conversations/mariana-safety";

const consultants = [
	{ active: true, id: "c1", name: "Ana" },
	{ active: true, id: "c2", name: "Bia" },
	{ active: true, id: "c3", name: "Cleo" },
];

test("guardrails bloqueiam frases de garantia sem fonte oficial", () => {
	assert.equal(isGuardrailHit("Você será contemplado em até 6 meses."), true);
	assert.equal(
		isGuardrailHit("A contemplação depende das regras do grupo."),
		false
	);
	assert.equal(
		isGuardrailHit("Recomendo um lance de 30% para esse grupo."),
		true
	);
	assert.equal(isGuardrailHit("Essa é a carta ideal para você."), true);
	assert.equal(isGuardrailHit("Não há garantia de contemplação."), false);
});

test("somente estados confirmados representam reunião confirmada", () => {
	assert.equal(isConfirmedAppointmentStatus("pending_confirmation"), false);
	assert.equal(isConfirmedAppointmentStatus("expired"), false);
	assert.equal(isConfirmedAppointmentStatus("confirmed"), true);
	assert.equal(isConfirmedAppointmentStatus("scheduled"), true);
});

test("a distribuição prioriza a menor carga atual de reuniões", () => {
	const selected = findMentorWithLowestLoad({
		activeLoads: {
			c1: 2,
			c2: 0,
			c3: 1,
		},
		compatibility: () => true,
		consultants,
		random: () => 0.9,
	});

	assert.equal(selected?.id, "c2");
});

test("em empate, a escolha usa a ordem atual e preserva o fallback por ordem de chegada", () => {
	const waitlist = createAvailabilityWaitlist([
		{ leadId: "lead-1", requestedAt: new Date("2026-09-14T09:00:00Z") },
		{ leadId: "lead-2", requestedAt: new Date("2026-09-14T09:05:00Z") },
		{ leadId: "lead-3", requestedAt: new Date("2026-09-14T09:10:00Z") },
	]);

	assert.deepEqual(
		waitlist.map((entry) => entry.leadId),
		["lead-1", "lead-2", "lead-3"]
	);
});
