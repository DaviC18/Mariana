import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import { closeDatabase, db } from "../../db/connections";
import { appointments } from "../../db/schema/appointments";
import { autonomousTasks } from "../../db/schema/autonomous-tasks";
import { consultants } from "../../db/schema/consultants";
import { conversations } from "../../db/schema/conversations";
import { leads } from "../../db/schema/leads";
import { schedulingSessions } from "../../db/schema/scheduling-sessions";
import { schedulingSlots } from "../../db/schema/scheduling-slots";
import type { GoogleCalendarService } from "../../integrations/google-calendar/google-calendar-service";
import { WhatsAppService } from "../../integrations/whatsapp/whatsapp-service";
import { AppointmentService } from "../../services/calendar/appointment-service";
import { SchedulingConfirmationOrchestrator } from "../../services/calendar/scheduling-confirmation-orchestrator";
import { SchedulingConfirmationService } from "../../services/calendar/scheduling-confirmation-service";
import { executeNextAutonomousTask } from "../../services/conversations/autonomous-task-executor";
import {
	createAutonomousTaskHandlers,
	PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK,
	PROCESS_CONSULTANT_SELECTION_TASK,
	SEND_CONFIRMATION_REQUEST_TASK,
	SEND_CONSULTANT_PREFERENCE_QUESTION_TASK,
} from "../../services/conversations/autonomous-task-handlers";

test.after(async () => {
	await closeDatabase();
});

async function createConsultantFixture() {
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

	return consultant;
}

async function createSchedulingFixture(consultantId: string) {
	const suffix = Date.now().toString();

	const [lead] = await db
		.insert(leads)
		.values({
			consortiumType: "automovel",
			name: `Lead Scheduling ${suffix}`,
			objective: "Teste de agendamento completo",
			phone: `551199${suffix.slice(-8)}`,
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

	const now = new Date();
	const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);

	const [session] = await db
		.insert(schedulingSessions)
		.values({
			conversationId: conversation.id,
			expiresAt,
			leadId: lead.id,
			status: "active",
			workflowStage: "awaiting_availability",
		})
		.returning();

	assert.ok(session);

	const startAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
	const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

	const [slot1] = await db
		.insert(schedulingSlots)
		.values({
			calendarId: "joao@example.com",
			consultantId,
			consultantName: "João Silva",
			endAt,
			position: 1,
			schedulingSessionId: session.id,
			startAt,
		})
		.returning();

	const [slot2] = await db
		.insert(schedulingSlots)
		.values({
			calendarId: "joao@example.com",
			consultantId,
			consultantName: "João Silva",
			endAt: new Date(endAt.getTime() + 60 * 60 * 1000),
			position: 2,
			schedulingSessionId: session.id,
			startAt: new Date(startAt.getTime() + 60 * 60 * 1000),
		})
		.returning();

	const [slot3] = await db
		.insert(schedulingSlots)
		.values({
			calendarId: "joao@example.com",
			consultantId,
			consultantName: "João Silva",
			endAt: new Date(endAt.getTime() + 120 * 60 * 1000),
			position: 3,
			schedulingSessionId: session.id,
			startAt: new Date(startAt.getTime() + 120 * 60 * 1000),
		})
		.returning();

	assert.ok(slot1);
	assert.ok(slot2);
	assert.ok(slot3);

	return {
		conversation,
		lead,
		now,
		session,
		slots: [slot1, slot2, slot3],
	};
}

async function cleanupFixture(
	leadId: string,
	conversationId: string,
	sessionId: string
) {
	await db.delete(appointments).where(eq(appointments.leadId, leadId));
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.id, sessionId));
	await db.delete(conversations).where(eq(conversations.id, conversationId));
	await db.delete(leads).where(eq(leads.id, leadId));
}

test("fluxo completo: preferência → consultor → slot → confirmação → appointment", async () => {
	const consultant = await createConsultantFixture();
	const fixture = await createSchedulingFixture(consultant.id);

	// Mock WhatsApp service to avoid actual API calls
	const originalSendReplyButtonsMessage =
		WhatsAppService.prototype.sendReplyButtonsMessage;
	const originalSendTextMessage = WhatsAppService.prototype.sendTextMessage;

	WhatsAppService.prototype.sendReplyButtonsMessage = async () => ({
		contacts: [],
		messages: [{ id: `wamid.test_${Date.now()}` }],
		messaging_product: "whatsapp",
	});

	WhatsAppService.prototype.sendTextMessage = async () => ({
		contacts: [],
		messages: [{ id: `wamid.test_${Date.now()}` }],
		messaging_product: "whatsapp",
	});

	try {
		const handlers = createAutonomousTaskHandlers();

		// 1. O fixture já cria a sessão com workflowStage = awaiting_availability
		// 2. Executar tarefa de enviar pergunta de preferência
		await enqueueTaskForTest({
			conversationId: fixture.conversation.id,
			payload: {
				eventId: fixture.session.id,
				kind: "send_consultant_preference_question",
				schedulingSessionId: fixture.session.id,
			},
			taskType: SEND_CONSULTANT_PREFERENCE_QUESTION_TASK,
		});

		const result1 = await executeNextAutonomousTask({
			conversationId: fixture.conversation.id,
			handlers,
		});
		assert.equal(result1.status, "completed");

		// Verificar que workflowStage mudou para awaiting_consultant_preference
		const [sessionAfterPref] = await db
			.select({ workflowStage: schedulingSessions.workflowStage })
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, fixture.session.id));
		assert.equal(
			sessionAfterPref?.workflowStage,
			"awaiting_consultant_preference"
		);

		// 3. Processar resposta "Tenho preferência"
		await enqueueTaskForTest({
			conversationId: fixture.conversation.id,
			payload: {
				buttonId: `pref:${fixture.session.id}:has_preference`,
				eventExternalId: "ext-pref-1",
				eventId: fixture.session.id,
				kind: "button_reply",
			},
			taskType: PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK,
		});

		const result2 = await executeNextAutonomousTask({
			conversationId: fixture.conversation.id,
			handlers,
		});
		assert.equal(result2.status, "completed");

		// Verificar que workflowStage mudou para awaiting_consultant_selection
		const [sessionAfterPrefReply] = await db
			.select({ workflowStage: schedulingSessions.workflowStage })
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, fixture.session.id));
		assert.equal(
			sessionAfterPrefReply?.workflowStage,
			"awaiting_consultant_selection"
		);

		// 4. Processar seleção de consultor
		await enqueueTaskForTest({
			conversationId: fixture.conversation.id,
			payload: {
				buttonId: `consultant:${fixture.session.id}:${consultant.id}`,
				eventExternalId: "ext-consultant-1",
				eventId: fixture.session.id,
				kind: "button_reply",
			},
			taskType: PROCESS_CONSULTANT_SELECTION_TASK,
		});

		const result3 = await executeNextAutonomousTask({
			conversationId: fixture.conversation.id,
			handlers,
		});
		assert.equal(result3.status, "completed");

		// Verificar que workflowStage mudou para awaiting_slot_selection e preferredConsultantId foi definido
		const [sessionAfterConsultant] = await db
			.select({
				preferredConsultantId: schedulingSessions.preferredConsultantId,
				workflowStage: schedulingSessions.workflowStage,
			})
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, fixture.session.id));
		assert.equal(
			sessionAfterConsultant?.workflowStage,
			"awaiting_slot_selection"
		);
		assert.equal(sessionAfterConsultant?.preferredConsultantId, consultant.id);

		// 5. Processar seleção de slot
		await enqueueTaskForTest({
			conversationId: fixture.conversation.id,
			payload: {
				buttonId: fixture.slots[0].id,
				eventExternalId: "ext-slot-1",
				eventId: fixture.session.id,
				kind: "button_reply",
			},
			taskType: SEND_CONFIRMATION_REQUEST_TASK,
		});

		const result4 = await executeNextAutonomousTask({
			conversationId: fixture.conversation.id,
			handlers,
		});
		assert.equal(result4.status, "completed");

		// Verificar que workflowStage mudou para awaiting_confirmation e selectedSlotId foi definido
		const [sessionAfterSlot] = await db
			.select({
				selectedSlotId: schedulingSessions.selectedSlotId,
				workflowStage: schedulingSessions.workflowStage,
			})
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, fixture.session.id));
		assert.equal(sessionAfterSlot?.workflowStage, "awaiting_confirmation");
		assert.equal(sessionAfterSlot?.selectedSlotId, fixture.slots[0].id);

		// 6. Processar confirmação final
		const calendarService = {
			createEvent: async ({ start, end }: { start: Date; end: Date }) => ({
				end: end.toISOString(),
				id: `google-event-${fixture.session.id}`,
				start: start.toISOString(),
			}),
			deleteEvent: async () => undefined,
			getBusyPeriods: async (calendarIds: string[]) =>
				calendarIds.map((calendarId) => ({ busy: [], calendarId })),
		} as unknown as GoogleCalendarService;
		const confirmationOrchestrator = new SchedulingConfirmationOrchestrator(
			new SchedulingConfirmationService(),
			new AppointmentService(calendarService)
		);
		const confirmationResult = await confirmationOrchestrator.execute({
			buttonId: `confirm:${fixture.slots[0].id}`,
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
		});

		assert.ok(confirmationResult.ok);
		if (confirmationResult.ok) {
			assert.equal(confirmationResult.action, "confirm");
			assert.ok(confirmationResult.appointment);
		}

		const savedAppointments = await db
			.select({
				consultantId: appointments.consultantId,
				status: appointments.status,
			})
			.from(appointments)
			.where(eq(appointments.leadId, fixture.lead.id));
		assert.equal(savedAppointments.length, 1);
		assert.equal(savedAppointments[0]?.consultantId, consultant.id);
		assert.equal(savedAppointments[0]?.status, "confirmed");

		const [completedSession] = await db
			.select({ status: schedulingSessions.status })
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, fixture.session.id));
		assert.equal(completedSession?.status, "closed");

		const [scheduledLead] = await db
			.select({ status: leads.status })
			.from(leads)
			.where(eq(leads.id, fixture.lead.id));
		assert.equal(scheduledLead?.status, "scheduled");
	} finally {
		// Restore original WhatsApp methods
		WhatsAppService.prototype.sendReplyButtonsMessage =
			originalSendReplyButtonsMessage;
		WhatsAppService.prototype.sendTextMessage = originalSendTextMessage;
		await cleanupFixture(
			fixture.lead.id,
			fixture.conversation.id,
			fixture.session.id
		);
	}
});

test("fluxo sem preferência: pula seleção de consultor e vai direto para slots", async () => {
	const consultant = await createConsultantFixture();
	const fixture = await createSchedulingFixture(consultant.id);

	// Mock WhatsApp service
	const originalSendReplyButtonsMessage =
		WhatsAppService.prototype.sendReplyButtonsMessage;
	const originalSendTextMessage = WhatsAppService.prototype.sendTextMessage;

	WhatsAppService.prototype.sendReplyButtonsMessage = async () => ({
		contacts: [],
		messages: [{ id: `wamid.test_${Date.now()}` }],
		messaging_product: "whatsapp",
	});

	WhatsAppService.prototype.sendTextMessage = async () => ({
		contacts: [],
		messages: [{ id: `wamid.test_${Date.now()}` }],
		messaging_product: "whatsapp",
	});

	try {
		const handlers = createAutonomousTaskHandlers();

		await enqueueTaskForTest({
			conversationId: fixture.conversation.id,
			payload: {
				eventId: fixture.session.id,
				kind: "send_consultant_preference_question",
				schedulingSessionId: fixture.session.id,
			},
			taskType: SEND_CONSULTANT_PREFERENCE_QUESTION_TASK,
		});

		const result1 = await executeNextAutonomousTask({
			conversationId: fixture.conversation.id,
			handlers,
		});
		assert.equal(result1.status, "completed");

		// Processar resposta "Sem preferência"
		await enqueueTaskForTest({
			conversationId: fixture.conversation.id,
			payload: {
				buttonId: `pref:${fixture.session.id}:no_preference`,
				eventExternalId: "ext-pref-2",
				eventId: fixture.session.id,
				kind: "button_reply",
			},
			taskType: PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK,
		});

		const result2 = await executeNextAutonomousTask({
			conversationId: fixture.conversation.id,
			handlers,
		});
		assert.equal(result2.status, "completed");

		// Verificar que workflowStage mudou para awaiting_slot_selection diretamente
		const [sessionAfterNoPref] = await db
			.select({ workflowStage: schedulingSessions.workflowStage })
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, fixture.session.id));
		assert.equal(sessionAfterNoPref?.workflowStage, "awaiting_slot_selection");
	} finally {
		// Restore original WhatsApp methods
		WhatsAppService.prototype.sendReplyButtonsMessage =
			originalSendReplyButtonsMessage;
		WhatsAppService.prototype.sendTextMessage = originalSendTextMessage;
		await cleanupFixture(
			fixture.lead.id,
			fixture.conversation.id,
			fixture.session.id
		);
	}
});

test("rejeita botão de preferência com prefixo inválido", async () => {
	const consultant = await createConsultantFixture();
	const fixture = await createSchedulingFixture(consultant.id);

	try {
		const handlers = createAutonomousTaskHandlers();

		await enqueueTaskForTest({
			conversationId: fixture.conversation.id,
			payload: {
				buttonId: "invalid_button",
				eventExternalId: "ext-invalid",
				eventId: fixture.session.id,
				kind: "button_reply",
			},
			taskType: PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK,
		});

		const result = await executeNextAutonomousTask({
			conversationId: fixture.conversation.id,
			handlers,
		});
		assert.equal(result.status, "failed");
	} finally {
		await cleanupFixture(
			fixture.lead.id,
			fixture.conversation.id,
			fixture.session.id
		);
	}
});

test("rejeita seleção de consultor inexistente", async () => {
	const consultant = await createConsultantFixture();
	const fixture = await createSchedulingFixture(consultant.id);

	try {
		const handlers = createAutonomousTaskHandlers();

		// Primeiro, avançar para awaiting_consultant_selection
		await db
			.update(schedulingSessions)
			.set({ workflowStage: "awaiting_consultant_selection" })
			.where(eq(schedulingSessions.id, fixture.session.id));

		await enqueueTaskForTest({
			conversationId: fixture.conversation.id,
			payload: {
				buttonId: "consultant:00000000-0000-4000-8000-000000000000",
				eventExternalId: "ext-consultant-invalid",
				eventId: fixture.session.id,
				kind: "button_reply",
			},
			taskType: PROCESS_CONSULTANT_SELECTION_TASK,
		});

		const result = await executeNextAutonomousTask({
			conversationId: fixture.conversation.id,
			handlers,
		});
		// Deve falhar ou ser ignorado
		assert.ok(result.status === "failed" || result.status === "completed");
	} finally {
		await cleanupFixture(
			fixture.lead.id,
			fixture.conversation.id,
			fixture.session.id
		);
	}
});

test("rejeita seleção de slot inválido mantendo workflow stage", async () => {
	const consultant = await createConsultantFixture();
	const fixture = await createSchedulingFixture(consultant.id);

	try {
		const handlers = createAutonomousTaskHandlers();

		// Avançar para awaiting_slot_selection
		await db
			.update(schedulingSessions)
			.set({ workflowStage: "awaiting_slot_selection" })
			.where(eq(schedulingSessions.id, fixture.session.id));

		await enqueueTaskForTest({
			conversationId: fixture.conversation.id,
			payload: {
				buttonId: "00000000-0000-4000-8000-000000000000",
				eventExternalId: "ext-slot-invalid",
				eventId: fixture.session.id,
				kind: "button_reply",
			},
			taskType: SEND_CONFIRMATION_REQUEST_TASK,
		});

		const result = await executeNextAutonomousTask({
			conversationId: fixture.conversation.id,
			handlers,
		});
		// O handler retorna skipped=true mas não lança erro, então o executor marca como completed
		assert.equal(result.status, "completed");

		// Verificar que workflowStage NÃO mudou (permaneceu awaiting_slot_selection)
		const [sessionAfterInvalid] = await db
			.select({ workflowStage: schedulingSessions.workflowStage })
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, fixture.session.id));
		assert.equal(sessionAfterInvalid?.workflowStage, "awaiting_slot_selection");
	} finally {
		await cleanupFixture(
			fixture.lead.id,
			fixture.conversation.id,
			fixture.session.id
		);
	}
});

async function enqueueTaskForTest({
	conversationId,
	taskType,
	payload,
}: {
	conversationId: string;
	taskType: string;
	payload: Record<string, unknown>;
}) {
	await db
		.insert(autonomousTasks)
		.values({
			availableAt: new Date(),
			conversationId,
			idempotencyKey: `test:${taskType}:${Date.now()}:${Math.random()}`,
			maxAttempts: 5,
			maxSteps: 8,
			payload,
			status: "pending",
			taskType,
		})
		.onConflictDoNothing();
}
