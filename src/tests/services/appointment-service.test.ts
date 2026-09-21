/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useDestructuring: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */
/** biome-ignore-all lint/performance/useTopLevelRegex: <> */

import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";

import { db } from "../../db/connections";
import { appointments } from "../../db/schema/appointments";
import { consultants } from "../../db/schema/consultants";
import { leads } from "../../db/schema/leads";
import { GoogleCalendarService } from "../../integrations/google-calendar/google-calendar-service";
import {
	AppointmentService,
	type CreateAppointmentInput,
} from "../../services/calendar/appointment-service";

const googleCalendarService = new GoogleCalendarService();
const appointmentService = new AppointmentService(googleCalendarService);

const TEST_PHONE = `551199${Date.now().toString().slice(-8)}`;

test("cria appointment confirmado com evento real no Google Calendar", async () => {
	const [consultant] = await db
		.select({
			calendarId: consultants.calendarId,
			id: consultants.id,
			name: consultants.name,
		})
		.from(consultants)
		.where(eq(consultants.active, true))
		.limit(1);

	assert.ok(consultant);

	const [lead] = await db
		.insert(leads)
		.values({
			name: "Lead Teste Appointment",
			phone: TEST_PHONE,
			objective: "Teste de agendamento da Mariana",
			consortiumType: "automovel",
			interestedInConsultant: true,
			status: "qualified",
			qualifiedAt: new Date(),
		})
		.returning({
			id: leads.id,
		});

	assert.ok(lead);

	const startAt = new Date();
	startAt.setDate(startAt.getDate() + 7);
	startAt.setHours(10, 0, 0, 0);

	const endAt = new Date(startAt);
	endAt.setMinutes(endAt.getMinutes() + 30);

	const input: CreateAppointmentInput = {
		consultantId: consultant.id,
		endAt,
		leadId: lead.id,
		startAt,
	};

	let appointmentId: string | undefined;
	let eventId: string | undefined;

	try {
		const result = await appointmentService.createConfirmedAppointment(input);

		appointmentId = result.appointmentId;
		eventId = result.externalEventId;

		assert.equal(result.status, "confirmed");
		assert.equal(result.consultantId, consultant.id);
		assert.equal(result.startAt.getTime(), startAt.getTime());
		assert.equal(result.endAt.getTime(), endAt.getTime());

		const [savedAppointment] = await db
			.select({
				consultantId: appointments.consultantId,
				endAt: appointments.endAt,
				externalEventId: appointments.externalEventId,
				leadId: appointments.leadId,
				startAt: appointments.startAt,
				status: appointments.status,
			})
			.from(appointments)
			.where(eq(appointments.id, result.appointmentId))
			.limit(1);

		assert.ok(savedAppointment);
		assert.equal(savedAppointment.leadId, lead.id);
		assert.equal(savedAppointment.consultantId, consultant.id);
		assert.equal(savedAppointment.externalEventId, result.externalEventId);
		assert.equal(savedAppointment.status, "confirmed");

		const [scheduledLead] = await db
			.select({ status: leads.status })
			.from(leads)
			.where(eq(leads.id, lead.id))
			.limit(1);

		assert.equal(scheduledLead?.status, "scheduled");

		const availability = await googleCalendarService.getBusyPeriods(
			[consultant.calendarId],
			startAt,
			endAt
		);

		assert.equal(availability.length, 1);
		assert.ok(availability[0]?.busy.length);
		assert.ok(
			availability[0].busy.some(
				(period) =>
					new Date(period.start).getTime() <= startAt.getTime() &&
					new Date(period.end).getTime() >= endAt.getTime()
			)
		);

		console.log("\nAppointment criado:");
		console.log(`Lead: ${lead.id}`);
		console.log(`Consultor: ${consultant.name}`);
		console.log(`Appointment: ${appointmentId}`);
		console.log(`Evento Google: ${eventId}`);
		console.log(`Início: ${startAt.toISOString()}`);
		console.log(`Fim: ${endAt.toISOString()}`);
	} finally {
		if (eventId) {
			try {
				await googleCalendarService.deleteEvent(consultant.calendarId, eventId);
			} catch (error) {
				console.error("Falha ao remover evento de teste:", error);
			}
		}

		if (appointmentId) {
			await db.delete(appointments).where(eq(appointments.id, appointmentId));
		}

		await db.delete(leads).where(eq(leads.id, lead.id));
	}
});

test("não cria appointment quando o horário já está ocupado no Google Calendar", async () => {
	const [consultant] = await db
		.select({
			calendarId: consultants.calendarId,
			id: consultants.id,
			name: consultants.name,
		})
		.from(consultants)
		.where(eq(consultants.active, true))
		.limit(1);

	assert.ok(consultant);

	const [lead] = await db
		.insert(leads)
		.values({
			name: "Lead Teste Conflito",
			phone: `551198${Date.now().toString().slice(-8)}`,
			objective: "Teste de conflito de agenda",
			consortiumType: "automovel",
			interestedInConsultant: true,
			status: "qualified",
			qualifiedAt: new Date(),
		})
		.returning({
			id: leads.id,
		});

	assert.ok(lead);

	const startAt = new Date();
	startAt.setDate(startAt.getDate() + 8);
	startAt.setHours(11, 0, 0, 0);

	const endAt = new Date(startAt);
	endAt.setMinutes(endAt.getMinutes() + 30);

	let eventId: string | undefined;

	try {
		const event = await googleCalendarService.createEvent({
			calendarId: consultant.calendarId,
			description: "Evento criado pelo teste de conflito.",
			end: endAt,
			start: startAt,
			summary: "TESTE - Horário ocupado",
		});

		eventId = event.id;

		await assert.rejects(
			() =>
				appointmentService.createConfirmedAppointment({
					consultantId: consultant.id,
					endAt,
					leadId: lead.id,
					startAt,
				}),
			/não está mais disponível no Google Calendar/
		);

		const appointmentsFound = await db
			.select({
				id: appointments.id,
			})
			.from(appointments)
			.where(
				and(
					eq(appointments.leadId, lead.id),
					eq(appointments.consultantId, consultant.id)
				)
			);

		assert.equal(appointmentsFound.length, 0);

		console.log("\nConflito detectado corretamente:");
		console.log(`Consultor: ${consultant.name}`);
		console.log(`Início: ${startAt.toISOString()}`);
		console.log(`Fim: ${endAt.toISOString()}`);
	} finally {
		if (eventId) {
			try {
				await googleCalendarService.deleteEvent(consultant.calendarId, eventId);
			} catch (error) {
				console.error("Falha ao remover evento de conflito:", error);
			}
		}

		await db.delete(leads).where(eq(leads.id, lead.id));
	}
});

test("rejeita intervalo inválido antes de consultar serviços externos", async () => {
	await assert.rejects(
		() =>
			appointmentService.createConfirmedAppointment({
				consultantId: "00000000-0000-4000-8000-000000000001",
				endAt: new Date("2026-10-01T10:00:00-03:00"),
				leadId: "00000000-0000-4000-8000-000000000002",
				startAt: new Date("2026-10-01T10:00:00-03:00"),
			}),
		/O início do agendamento deve ser anterior ao fim/
	);
});

test("rejeita consultor inexistente sem criar evento", async () => {
	await assert.rejects(
		() =>
			appointmentService.createConfirmedAppointment({
				consultantId: "00000000-0000-4000-8000-000000000001",
				endAt: new Date("2026-10-01T10:30:00-03:00"),
				leadId: "00000000-0000-4000-8000-000000000002",
				startAt: new Date("2026-10-01T10:00:00-03:00"),
			}),
		/Consultor não encontrado/
	);
});
