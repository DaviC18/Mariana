/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/suspicious/noUnnecessaryConditions: <> */
/** biome-ignore-all lint/style/useDestructuring: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */
/** biome-ignore-all lint/performance/useTopLevelRegex: <> */

import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";

import { closeDatabase, db } from "../../db/connections";
import { appointments } from "../../db/schema/appointments";
import { consultants } from "../../db/schema/consultants";
import { conversations } from "../../db/schema/conversations";
import { leads } from "../../db/schema/leads";
import { schedulingSessions } from "../../db/schema/scheduling-sessions";
import {
	AppointmentService,
	type CreateAppointmentInput,
} from "../../services/calendar/appointment-service";

function createMockGoogleCalendarService() {
	let eventId = "google-event-test";
	let busy = false;
	let getBusyPeriodsCalls = 0;
	let createEventCalls = 0;

	const service = {
		getBusyPeriods: (calendarIds: string[], start: Date, end: Date) => {
			getBusyPeriodsCalls += 1;

			return [
				{
					busy: busy
						? [
								{
									start: start.toISOString(),
									end: end.toISOString(),
								},
							]
						: [],
					calendarId: calendarIds[0] ?? "test-calendar",
				},
			];
		},

		createEvent: () => {
			createEventCalls += 1;
			busy = true;

			return {
				id: eventId,
			};
		},

		deleteEvent: (_calendarId: string, _eventId: string) => {
			busy = false;
		},

		setBusy(value: boolean) {
			busy = value;
		},

		setEventId(value: string) {
			eventId = value;
		},

		getCallCounts() {
			return { createEventCalls, getBusyPeriodsCalls };
		},
	};

	return service as any;
}

test.after(async () => {
	await closeDatabase();
});

const TEST_PHONE = `551199${Date.now().toString().slice(-8)}`;

const FIXED_NOW = new Date("2026-10-12T10:00:00.000Z");

async function createSchedulingFixture({
	expiresAt = new Date("2026-10-12T10:15:00.000Z"),
	sessionLeadIsDifferent = false,
	sessionStatus = "active",
}: {
	expiresAt?: Date;
	sessionLeadIsDifferent?: boolean;
	sessionStatus?: "active" | "closed" | "expired";
} = {}) {
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

	const testPhone = `55119${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const [lead] = await db
		.insert(leads)
		.values({
			consortiumType: "geral",
			name: "Lead Teste Scheduling Session",
			objective: "Teste de validade da sessão",
			phone: testPhone,
			status: "qualified",
		})
		.returning({ id: leads.id });

	assert.ok(lead);

	let sessionLeadId = lead.id;
	let otherLeadId: string | undefined;
	if (sessionLeadIsDifferent) {
		const [otherLead] = await db
			.insert(leads)
			.values({
				consortiumType: "geral",
				name: "Lead Dono da Sessão",
				objective: "Teste de ownership da sessão",
				phone: `${testPhone}9`,
				status: "qualified",
			})
			.returning({ id: leads.id });

		assert.ok(otherLead);
		sessionLeadId = otherLead.id;
		otherLeadId = otherLead.id;
	}

	const [conversation] = await db
		.insert(conversations)
		.values({ leadId: sessionLeadId })
		.returning({ id: conversations.id });

	assert.ok(conversation);

	const [session] = await db
		.insert(schedulingSessions)
		.values({
			conversationId: conversation.id,
			createdAt: FIXED_NOW,
			expiresAt,
			leadId: sessionLeadId,
			status: sessionStatus,
			updatedAt: FIXED_NOW,
		})
		.returning({ id: schedulingSessions.id });

	assert.ok(session);

	return {
		consultant,
		conversationId: conversation.id,
		leadId: lead.id,
		otherLeadId,
		sessionId: session.id,
	};
}

async function assertNoAppointment(leadId: string) {
	const foundAppointments = await db
		.select({ id: appointments.id })
		.from(appointments)
		.where(eq(appointments.leadId, leadId));

	assert.equal(foundAppointments.length, 0);
}

async function assertSchedulingSessionRejected(
	fixture: Awaited<ReturnType<typeof createSchedulingFixture>>,
	expectedCode: string
) {
	const calendarService = createMockGoogleCalendarService();
	const service = new AppointmentService(calendarService);

	await assert.rejects(
		() =>
			service.createConfirmedAppointment({
				consultantId: fixture.consultant.id,
				endAt: new Date("2035-01-01T13:30:00.000Z"),
				leadId: fixture.leadId,
				now: FIXED_NOW,
				schedulingSessionId: fixture.sessionId,
				startAt: new Date("2035-01-01T13:00:00.000Z"),
			}),
		(error: any) => error.code === expectedCode
	);

	assert.deepEqual(calendarService.getCallCounts(), {
		createEventCalls: 0,
		getBusyPeriodsCalls: 0,
	});
	await assertNoAppointment(fixture.leadId);
}

async function cleanupSchedulingFixture(fixture: {
	conversationId: string;
	leadId: string;
	otherLeadId?: string;
	sessionId: string;
}) {
	await db.delete(appointments).where(eq(appointments.leadId, fixture.leadId));
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.id, fixture.sessionId));
	await db
		.delete(conversations)
		.where(eq(conversations.id, fixture.conversationId));
	if (fixture.otherLeadId) {
		await db.delete(leads).where(eq(leads.id, fixture.otherLeadId));
	}
	await db.delete(leads).where(eq(leads.id, fixture.leadId));
}

test("cria appointment confirmado com Google Calendar mockado", async () => {
	const mockGoogleCalendarService = createMockGoogleCalendarService();
	const appointmentService = new AppointmentService(mockGoogleCalendarService);

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
		assert.equal(result.externalEventId, "google-event-test");

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

		const availability = await mockGoogleCalendarService.getBusyPeriods(
			[consultant.calendarId],
			startAt,
			endAt
		);

		assert.equal(availability.length, 1);
		assert.equal(availability[0]?.busy.length, 1);

		assert.ok(
			availability[0]?.busy.some(
				(period: { start: string; end: string }) =>
					new Date(period.start).getTime() <= startAt.getTime() &&
					new Date(period.end).getTime() >= endAt.getTime()
			)
		);

		console.log("\nAppointment criado:");
		console.log(`Lead: ${lead.id}`);
		console.log(`Consultor: ${consultant.name}`);
		console.log(`Appointment: ${appointmentId}`);
		console.log(`Evento Google mockado: ${eventId}`);
		console.log(`Início: ${startAt.toISOString()}`);
		console.log(`Fim: ${endAt.toISOString()}`);
	} finally {
		if (eventId) {
			mockGoogleCalendarService.deleteEvent(consultant.calendarId, eventId);
		}

		if (appointmentId) {
			await db.delete(appointments).where(eq(appointments.id, appointmentId));
		}

		await db.delete(leads).where(eq(leads.id, lead.id));
	}
});

test("não cria appointment quando o horário já está ocupado no Google Calendar", async () => {
	const mockGoogleCalendarService = createMockGoogleCalendarService();

	mockGoogleCalendarService.setEventId("google-conflict-event");
	mockGoogleCalendarService.setBusy(true);

	const appointmentService = new AppointmentService(mockGoogleCalendarService);

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

	try {
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
		await db.delete(leads).where(eq(leads.id, lead.id));
	}
});

test("rejeita intervalo inválido antes de consultar serviços externos", async () => {
	const service = new AppointmentService(createMockGoogleCalendarService());

	await assert.rejects(
		() =>
			service.createConfirmedAppointment({
				consultantId: "00000000-0000-4000-8000-000000000001",
				endAt: new Date("2026-10-01T10:00:00-03:00"),
				leadId: "00000000-0000-4000-8000-000000000002",
				startAt: new Date("2026-10-01T10:00:00-03:00"),
			}),
		/O início do agendamento deve ser anterior ao fim/
	);
});

test("rejeita consultor inexistente sem criar evento", async () => {
	const service = new AppointmentService(createMockGoogleCalendarService());

	await assert.rejects(
		() =>
			service.createConfirmedAppointment({
				consultantId: "00000000-0000-4000-8000-000000000001",
				endAt: new Date("2026-10-01T10:30:00-03:00"),
				leadId: "00000000-0000-4000-8000-000000000002",
				startAt: new Date("2026-10-01T10:00:00-03:00"),
			}),
		/Consultor não encontrado/
	);
});

test("fecha scheduling session na mesma transação da confirmação do appointment", async () => {
	const [consultant] = await db
		.select({
			active: consultants.active,
			calendarId: consultants.calendarId,
			id: consultants.id,
			name: consultants.name,
		})
		.from(consultants)
		.where(eq(consultants.active, true))
		.limit(1);

	assert.ok(consultant);

	const testPhone = `55119${Date.now()}`;

	const [lead] = await db
		.insert(leads)
		.values({
			consortiumType: "geral",
			name: "Lead Teste Session Close",
			objective: "Teste fechamento session",
			phone: testPhone,
			status: "qualified",
		})
		.returning({
			id: leads.id,
		});

	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({
			leadId: lead.id,
		})
		.returning({
			id: conversations.id,
		});

	assert.ok(conversation);

	const [session] = await db
		.insert(schedulingSessions)
		.values({
			conversationId: conversation.id,
			createdAt: FIXED_NOW,
			expiresAt: new Date(FIXED_NOW.getTime() + 15 * 60 * 1000),
			leadId: lead.id,
			status: "active",
			updatedAt: FIXED_NOW,
		})
		.returning();

	assert.ok(session);

	const startAt = new Date("2026-10-01T13:00:00.000Z");
	const endAt = new Date("2026-10-01T13:30:00.000Z");

	const calendarEvent = {
		id: "google-event-session-close-test",
	};

	const mockGoogleCalendarService = {
		getBusyPeriods: () => [
			{
				busy: [],
				calendarId: consultant.calendarId,
			},
		],

		createEvent: () => calendarEvent,

		deleteEvent: (_calendarId: string, _eventId: string) => undefined,
	} as any;

	const service = new AppointmentService(mockGoogleCalendarService);

	try {
		const result = await service.createConfirmedAppointment({
			consultantId: consultant.id,
			endAt,
			leadId: lead.id,
			now: FIXED_NOW,
			schedulingSessionId: session.id,
			startAt,
		});

		assert.equal(result.status, "confirmed");
		assert.equal(result.externalEventId, calendarEvent.id);

		const [updatedSession] = await db
			.select({
				status: schedulingSessions.status,
			})
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, session.id))
			.limit(1);

		assert.ok(updatedSession);

		assert.equal(
			updatedSession.status,
			"closed",
			"A scheduling session confirmada deve ficar closed"
		);

		const [updatedLead] = await db
			.select({
				status: leads.status,
			})
			.from(leads)
			.where(eq(leads.id, lead.id))
			.limit(1);

		assert.ok(updatedLead);
		assert.equal(updatedLead.status, "scheduled");

		const [createdAppointment] = await db
			.select({
				id: appointments.id,
				status: appointments.status,
			})
			.from(appointments)
			.where(eq(appointments.id, result.appointmentId))
			.limit(1);

		assert.ok(createdAppointment);
		assert.equal(createdAppointment.status, "confirmed");
	} finally {
		await db.delete(appointments).where(eq(appointments.leadId, lead.id));

		await db
			.delete(schedulingSessions)
			.where(eq(schedulingSessions.id, session.id));

		await db.delete(conversations).where(eq(conversations.id, conversation.id));

		await db.delete(leads).where(eq(leads.id, lead.id));
	}
});

test("expira e rejeita sessão ativa no instante do vencimento sem chamar Calendar", async () => {
	const fixture = await createSchedulingFixture({ expiresAt: FIXED_NOW });

	try {
		await assertSchedulingSessionRejected(
			fixture,
			"scheduling_session_expired"
		);

		const [updatedSession] = await db
			.select({
				expiresAt: schedulingSessions.expiresAt,
				status: schedulingSessions.status,
				updatedAt: schedulingSessions.updatedAt,
			})
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, fixture.sessionId))
			.limit(1);

		assert.equal(updatedSession?.status, "expired");
		assert.equal(updatedSession?.expiresAt.getTime(), FIXED_NOW.getTime());
		assert.equal(updatedSession?.updatedAt.getTime(), FIXED_NOW.getTime());
	} finally {
		await cleanupSchedulingFixture(fixture);
	}
});

test("rejeita sessão já expirada sem chamar Calendar", async () => {
	const fixture = await createSchedulingFixture({
		sessionStatus: "expired",
	});

	try {
		await assertSchedulingSessionRejected(
			fixture,
			"scheduling_session_expired"
		);

		const [session] = await db
			.select({ status: schedulingSessions.status })
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, fixture.sessionId))
			.limit(1);

		assert.equal(session?.status, "expired");
	} finally {
		await cleanupSchedulingFixture(fixture);
	}
});

test("rejeita sessão fechada sem reclassificá-la como expirada", async () => {
	const fixture = await createSchedulingFixture({
		expiresAt: new Date("2026-10-12T09:59:59.999Z"),
		sessionStatus: "closed",
	});

	try {
		await assertSchedulingSessionRejected(
			fixture,
			"scheduling_session_invalid"
		);

		const [session] = await db
			.select({ status: schedulingSessions.status })
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, fixture.sessionId))
			.limit(1);

		assert.equal(session?.status, "closed");
	} finally {
		await cleanupSchedulingFixture(fixture);
	}
});

test("rejeita sessão inexistente sem chamar Calendar", async () => {
	const fixture = await createSchedulingFixture();

	try {
		await db
			.delete(schedulingSessions)
			.where(eq(schedulingSessions.id, fixture.sessionId));

		await assertSchedulingSessionRejected(
			fixture,
			"scheduling_session_invalid"
		);
	} finally {
		await cleanupSchedulingFixture(fixture);
	}
});

test("rejeita ID de sessão vazio sem tratar como fluxo sem sessão", async () => {
	const fixture = await createSchedulingFixture();
	const calendarService = createMockGoogleCalendarService();
	const service = new AppointmentService(calendarService);

	try {
		await assert.rejects(
			() =>
				service.createConfirmedAppointment({
					consultantId: fixture.consultant.id,
					endAt: new Date("2035-01-01T13:30:00.000Z"),
					leadId: fixture.leadId,
					now: FIXED_NOW,
					schedulingSessionId: "",
					startAt: new Date("2035-01-01T13:00:00.000Z"),
				}),
			(error: any) => error.code === "scheduling_session_invalid"
		);

		assert.deepEqual(calendarService.getCallCounts(), {
			createEventCalls: 0,
			getBusyPeriodsCalls: 0,
		});
		await assertNoAppointment(fixture.leadId);
	} finally {
		await cleanupSchedulingFixture(fixture);
	}
});

test("rejeita sessão pertencente a outro lead sem chamar Calendar", async () => {
	const fixture = await createSchedulingFixture({
		sessionLeadIsDifferent: true,
	});

	try {
		await assertSchedulingSessionRejected(
			fixture,
			"scheduling_session_invalid"
		);

		const [session] = await db
			.select({
				leadId: schedulingSessions.leadId,
				status: schedulingSessions.status,
			})
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, fixture.sessionId))
			.limit(1);

		assert.equal(session?.leadId, fixture.otherLeadId);
		assert.equal(session?.status, "active");
	} finally {
		await cleanupSchedulingFixture(fixture);
	}
});

test("revalida a sessão após disponibilidade antes de criar evento", async () => {
	const fixture = await createSchedulingFixture();
	let createEventCalls = 0;
	let deleteEventCalls = 0;
	const calendarService = {
		getBusyPeriods: async () => {
			await db
				.update(schedulingSessions)
				.set({ status: "closed" })
				.where(eq(schedulingSessions.id, fixture.sessionId));

			return [{ busy: [], calendarId: fixture.consultant.calendarId }];
		},
		createEvent: () => {
			createEventCalls += 1;
			return { id: "google-event-session-closed-before-create" };
		},
		deleteEvent: () => {
			deleteEventCalls += 1;
		},
	} as any;

	try {
		const service = new AppointmentService(calendarService);

		await assert.rejects(() =>
			service.createConfirmedAppointment({
				consultantId: fixture.consultant.id,
				endAt: new Date("2035-01-01T13:30:00.000Z"),
				leadId: fixture.leadId,
				now: FIXED_NOW,
				schedulingSessionId: fixture.sessionId,
				startAt: new Date("2035-01-01T13:00:00.000Z"),
			})
		);

		assert.equal(createEventCalls, 0);
		assert.equal(deleteEventCalls, 0);
		await assertNoAppointment(fixture.leadId);
	} finally {
		await cleanupSchedulingFixture(fixture);
	}
});

test("descarta o evento se a sessão fechar durante a criação no Calendar", async () => {
	const fixture = await createSchedulingFixture();
	let deleteEventCalls = 0;
	const calendarService = {
		getBusyPeriods: () => [
			{ busy: [], calendarId: fixture.consultant.calendarId },
		],
		createEvent: async () => {
			await db
				.update(schedulingSessions)
				.set({ status: "closed" })
				.where(eq(schedulingSessions.id, fixture.sessionId));

			return { id: "google-event-raced-session" };
		},
		deleteEvent: () => {
			deleteEventCalls += 1;
		},
	} as any;

	try {
		const service = new AppointmentService(calendarService);

		await assert.rejects(() =>
			service.createConfirmedAppointment({
				consultantId: fixture.consultant.id,
				endAt: new Date("2035-01-01T13:30:00.000Z"),
				leadId: fixture.leadId,
				now: FIXED_NOW,
				schedulingSessionId: fixture.sessionId,
				startAt: new Date("2035-01-01T13:00:00.000Z"),
			})
		);

		assert.equal(deleteEventCalls, 1);
		await assertNoAppointment(fixture.leadId);
	} finally {
		await cleanupSchedulingFixture(fixture);
	}
});
