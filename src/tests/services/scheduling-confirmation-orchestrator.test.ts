/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
import assert from "node:assert/strict";
import test from "node:test";

import type { schedulingSessions, schedulingSlots } from "../../db/schema";
import type {
	AppointmentService,
	CreatedAppointment,
} from "../../services/calendar/appointment-service";
import { SchedulingConfirmationOrchestrator } from "../../services/calendar/scheduling-confirmation-orchestrator";
import type { SchedulingConfirmationService } from "../../services/calendar/scheduling-confirmation-service";

const session = {
	conversationId: "33333333-3333-4333-8333-333333333333",
	createdAt: new Date("2026-09-28T10:00:00.000Z"),
	expiresAt: new Date("2026-09-28T10:15:00.000Z"),
	id: "11111111-1111-4111-8111-111111111111",
	leadId: "22222222-2222-4222-8222-222222222222",
	status: "active",
	updatedAt: new Date("2026-09-28T10:00:00.000Z"),
} as typeof schedulingSessions.$inferSelect;

const slot = {
	calendarId: "joao@example.com",
	consultantId: "55555555-5555-4555-8555-555555555555",
	consultantName: "João Silva",
	createdAt: new Date("2026-09-28T10:00:00.000Z"),
	endAt: new Date("2026-09-29T13:30:00.000Z"),
	id: "44444444-4444-4444-8444-444444444444",
	position: 1,
	schedulingSessionId: session.id,
	startAt: new Date("2026-09-29T13:00:00.000Z"),
} as typeof schedulingSlots.$inferSelect;

const appointment = {
	appointmentId: "66666666-6666-4666-8666-666666666666",
	calendarEvent: {
		id: "google-event-123",
	} as CreatedAppointment["calendarEvent"],
	consultantId: slot.consultantId,
	endAt: slot.endAt,
	externalEventId: "google-event-123",
	startAt: slot.startAt,
	status: "confirmed",
} as CreatedAppointment;

function createOrchestrator(
	confirmationResult: any,
	appointmentResult?: CreatedAppointment
) {
	const schedulingConfirmationService = {
		resolveConfirmation: async () => confirmationResult,
	} as unknown as SchedulingConfirmationService;

	const appointmentService = {
		createConfirmedAppointment: async () => {
			if (appointmentResult) {
				return appointmentResult;
			}

			throw new Error("appointment failed");
		},
	} as unknown as AppointmentService;

	return new SchedulingConfirmationOrchestrator(
		schedulingConfirmationService,
		appointmentService
	);
}

test("confirma agendamento e chama AppointmentService com os dados do slot", async () => {
	const orchestrator = createOrchestrator(
		{
			action: "confirm",
			ok: true,
			session,
			slot,
		},
		appointment
	);

	const result = await orchestrator.execute({
		buttonId: `confirm:${slot.id}`,
		conversationId: session.conversationId,
		leadId: session.leadId,
	});

	assert.equal(result.ok, true);

	if (!result.ok) {
		return;
	}

	assert.equal(result.action, "confirm");
	assert.equal(result.appointment.appointmentId, appointment.appointmentId);
	assert.equal(result.slot.id, slot.id);
	assert.equal(result.session.id, session.id);
});

test("não cria appointment quando a ação é cancel", async () => {
	let appointmentCalled = false;

	const schedulingConfirmationService = {
		resolveConfirmation: async () => ({
			action: "cancel" as const,
			ok: true as const,
			session,
			slot,
		}),
	} as unknown as SchedulingConfirmationService;

	const appointmentService = {
		createConfirmedAppointment: async () => {
			appointmentCalled = true;

			return appointment;
		},
	} as unknown as AppointmentService;

	const orchestrator = new SchedulingConfirmationOrchestrator(
		schedulingConfirmationService,
		appointmentService
	);

	const result = await orchestrator.execute({
		buttonId: `cancel:${slot.id}`,
		conversationId: session.conversationId,
		leadId: session.leadId,
	});

	assert.equal(result.ok, true);

	if (!result.ok) {
		return;
	}

	assert.equal(result.action, "cancel");
	assert.equal(result.slot.id, slot.id);
	assert.equal(appointmentCalled, false);
});

test("propaga falha da validação de confirmação sem chamar AppointmentService", async () => {
	let appointmentCalled = false;

	const schedulingConfirmationService = {
		resolveConfirmation: async () => ({
			ok: false as const,
			reason: "expired" as const,
		}),
	} as unknown as SchedulingConfirmationService;

	const appointmentService = {
		createConfirmedAppointment: async () => {
			appointmentCalled = true;

			return appointment;
		},
	} as unknown as AppointmentService;

	const orchestrator = new SchedulingConfirmationOrchestrator(
		schedulingConfirmationService,
		appointmentService
	);

	const result = await orchestrator.execute({
		buttonId: `confirm:${slot.id}`,
		conversationId: session.conversationId,
		leadId: session.leadId,
	});

	assert.deepEqual(result, {
		ok: false,
		reason: "expired",
	});

	assert.equal(appointmentCalled, false);
});

test("retorna appointment_failed quando AppointmentService falha", async () => {
	const orchestrator = createOrchestrator({
		action: "confirm",
		ok: true,
		session,
		slot,
	});

	const result = await orchestrator.execute({
		buttonId: `confirm:${slot.id}`,
		conversationId: session.conversationId,
		leadId: session.leadId,
	});

	assert.deepEqual(result, {
		ok: false,
		reason: "appointment_failed",
	});
});
