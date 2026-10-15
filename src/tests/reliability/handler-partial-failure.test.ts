/** biome-ignore-all lint/suspicious/useAwait: mocks assíncronos do Calendar */
/**
 * Falhas parciais nos handlers de agendamento: a transição de estado da
 * sessão e o enfileiramento da mensagem no outbox precisam ser atômicos.
 * Se o INSERT no outbox falhar, a nova tentativa da tarefa ainda deve
 * produzir a mensagem para o cliente, em vez de encontrar a sessão já
 * avançada e encerrar a tarefa sem resposta.
 *
 * A falha é injetada no próprio Postgres (trigger que rejeita o INSERT de uma
 * idempotencyKey específica), sem mocks dos serviços.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { eq, sql } from "drizzle-orm";

import { closeDatabase, db } from "../../db/connections";
import {
	appointments,
	autonomousTasks,
	consultants,
	conversations,
	leads,
	outboundMessages,
	schedulingSessions,
	schedulingSlots,
} from "../../db/schema";
import { GoogleCalendarService } from "../../integrations/google-calendar/google-calendar-service";
import { executeNextAutonomousTask } from "../../services/conversations/autonomous-task-executor";
import {
	createAutonomousTaskHandlers,
	PROCESS_BUTTON_REPLY_TASK,
	PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK,
	PROCESS_CONSULTANT_SELECTION_TASK,
	SEND_CONFIRMATION_REQUEST_TASK,
	SEND_CONSULTANT_PREFERENCE_QUESTION_TASK,
} from "../../services/conversations/autonomous-task-handlers";

type WorkflowStage =
	| "awaiting_availability"
	| "awaiting_consultant_preference"
	| "awaiting_consultant_selection"
	| "awaiting_slot_selection"
	| "awaiting_confirmation";

test.before(async () => {
	await db.execute(sql`
		CREATE TABLE IF NOT EXISTS "test_outbound_insert_faults" (
			"idempotencyKey" text PRIMARY KEY
		)
	`);
	await db.execute(sql`
		CREATE OR REPLACE FUNCTION test_reject_faulty_outbound_insert()
		RETURNS trigger AS $$
		BEGIN
			IF EXISTS (
				SELECT 1 FROM "test_outbound_insert_faults"
				WHERE "idempotencyKey" = NEW."idempotencyKey"
			) THEN
				RAISE EXCEPTION 'injected outbox insert failure';
			END IF;
			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql
	`);
	await db.execute(sql`
		DROP TRIGGER IF EXISTS test_reject_faulty_outbound_insert
		ON "outbound_messages"
	`);
	await db.execute(sql`
		CREATE TRIGGER test_reject_faulty_outbound_insert
		BEFORE INSERT ON "outbound_messages"
		FOR EACH ROW EXECUTE FUNCTION test_reject_faulty_outbound_insert()
	`);
});

test.after(async () => {
	await db.execute(sql`
		DROP TRIGGER IF EXISTS test_reject_faulty_outbound_insert
		ON "outbound_messages"
	`);
	await db.execute(
		sql`DROP FUNCTION IF EXISTS test_reject_faulty_outbound_insert()`
	);
	await db.execute(sql`DROP TABLE IF EXISTS "test_outbound_insert_faults"`);
	await closeDatabase();
});

async function failOutboundInsert(idempotencyKey: string) {
	await db.execute(
		sql`INSERT INTO "test_outbound_insert_faults" VALUES (${idempotencyKey})`
	);
}

async function allowOutboundInsert(idempotencyKey: string) {
	await db.execute(
		sql`DELETE FROM "test_outbound_insert_faults" WHERE "idempotencyKey" = ${idempotencyKey}`
	);
}

async function createFixture(workflowStage: WorkflowStage) {
	const [consultant] = await db
		.select({ id: consultants.id, name: consultants.name })
		.from(consultants)
		.where(eq(consultants.active, true))
		.limit(1);
	assert.ok(consultant);

	const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const [lead] = await db
		.insert(leads)
		.values({
			name: `Lead Falha Parcial ${suffix}`,
			phone: `5511${suffix.slice(-9)}`,
			status: "qualified",
		})
		.returning({ id: leads.id });
	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({ lastCustomerMessageAt: new Date(), leadId: lead.id })
		.returning({ id: conversations.id });
	assert.ok(conversation);

	const now = new Date();
	const [session] = await db
		.insert(schedulingSessions)
		.values({
			conversationId: conversation.id,
			expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
			leadId: lead.id,
			status: "active",
			workflowStage,
		})
		.returning();
	assert.ok(session);

	const startAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
	const [slot] = await db
		.insert(schedulingSlots)
		.values({
			calendarId: "audit@example.com",
			consultantId: consultant.id,
			consultantName: consultant.name,
			endAt: new Date(startAt.getTime() + 30 * 60 * 1000),
			position: 1,
			schedulingSessionId: session.id,
			startAt,
		})
		.returning();
	assert.ok(slot);

	return { consultant, conversation, lead, session, slot };
}

async function cleanup(fixture: Awaited<ReturnType<typeof createFixture>>) {
	await db.delete(appointments).where(eq(appointments.leadId, fixture.lead.id));
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.id, fixture.session.id));
	await db
		.delete(conversations)
		.where(eq(conversations.id, fixture.conversation.id));
	await db.delete(leads).where(eq(leads.id, fixture.lead.id));
}

async function enqueueTask(
	conversationId: string,
	taskType: string,
	payload: Record<string, unknown>
) {
	await db.insert(autonomousTasks).values({
		conversationId,
		idempotencyKey: `test:partial-failure:${taskType}:${Date.now()}:${Math.random()}`,
		payload,
		taskType,
	});
}

/** Executa a tarefa, que deve falhar no outbox, e depois a nova tentativa. */
async function runWithOneOutboxFailure(
	conversationId: string,
	outboundKey: string
) {
	const handlers = createAutonomousTaskHandlers();

	await failOutboundInsert(outboundKey);
	try {
		const firstAttempt = await executeNextAutonomousTask({
			conversationId,
			handlers,
		});
		assert.equal(firstAttempt.status, "retry_scheduled");
	} finally {
		await allowOutboundInsert(outboundKey);
	}

	// Antecipa o backoff para executar a nova tentativa imediatamente.
	await db
		.update(autonomousTasks)
		.set({ availableAt: new Date(0) })
		.where(eq(autonomousTasks.conversationId, conversationId));

	const retry = await executeNextAutonomousTask({ conversationId, handlers });
	assert.equal(retry.status, "completed");

	const [outbound] = await db
		.select()
		.from(outboundMessages)
		.where(eq(outboundMessages.idempotencyKey, outboundKey));

	return outbound;
}

async function sessionStage(sessionId: string) {
	const [session] = await db
		.select({ workflowStage: schedulingSessions.workflowStage })
		.from(schedulingSessions)
		.where(eq(schedulingSessions.id, sessionId));
	return session?.workflowStage;
}

test("pergunta de preferência é enfileirada na nova tentativa após falha no outbox", async () => {
	const fixture = await createFixture("awaiting_availability");
	try {
		await enqueueTask(
			fixture.conversation.id,
			SEND_CONSULTANT_PREFERENCE_QUESTION_TASK,
			{ schedulingSessionId: fixture.session.id }
		);

		const outbound = await runWithOneOutboxFailure(
			fixture.conversation.id,
			`consultant-preference:${fixture.conversation.id}:${fixture.session.id}`
		);

		assert.ok(outbound, "a pergunta de preferência nunca foi enfileirada");
		assert.equal(
			await sessionStage(fixture.session.id),
			"awaiting_consultant_preference"
		);
	} finally {
		await cleanup(fixture);
	}
});

test("resposta 'sem preferência' é enfileirada na nova tentativa após falha no outbox", async () => {
	const fixture = await createFixture("awaiting_consultant_preference");
	try {
		const externalId = `wamid.partial.pref.${Date.now()}`;
		await enqueueTask(
			fixture.conversation.id,
			PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK,
			{
				buttonId: `pref:${fixture.session.id}:no_preference`,
				eventExternalId: externalId,
			}
		);

		const outbound = await runWithOneOutboxFailure(
			fixture.conversation.id,
			`consultant-preference-reply:${fixture.conversation.id}:${externalId}`
		);

		assert.ok(outbound, "os horários nunca foram enfileirados");
		assert.equal(
			await sessionStage(fixture.session.id),
			"awaiting_slot_selection"
		);
	} finally {
		await cleanup(fixture);
	}
});

test("resposta 'tenho preferência' é enfileirada na nova tentativa após falha no outbox", async () => {
	const fixture = await createFixture("awaiting_consultant_preference");
	try {
		const externalId = `wamid.partial.haspref.${Date.now()}`;
		await enqueueTask(
			fixture.conversation.id,
			PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK,
			{
				buttonId: `pref:${fixture.session.id}:has_preference`,
				eventExternalId: externalId,
			}
		);

		const outbound = await runWithOneOutboxFailure(
			fixture.conversation.id,
			`consultant-preference-reply:${fixture.conversation.id}:${externalId}`
		);

		assert.ok(outbound, "a lista de consultores nunca foi enfileirada");
		assert.equal(
			await sessionStage(fixture.session.id),
			"awaiting_consultant_selection"
		);
	} finally {
		await cleanup(fixture);
	}
});

test("seleção de consultor é enfileirada na nova tentativa após falha no outbox", async () => {
	const fixture = await createFixture("awaiting_consultant_selection");
	try {
		const externalId = `wamid.partial.consultant.${Date.now()}`;
		await enqueueTask(
			fixture.conversation.id,
			PROCESS_CONSULTANT_SELECTION_TASK,
			{
				buttonId: `consultant:${fixture.session.id}:${fixture.consultant.id}`,
				eventExternalId: externalId,
			}
		);

		const outbound = await runWithOneOutboxFailure(
			fixture.conversation.id,
			`consultant-selection:${fixture.conversation.id}:${externalId}`
		);

		assert.ok(outbound, "os horários do consultor nunca foram enfileirados");
		assert.equal(
			await sessionStage(fixture.session.id),
			"awaiting_slot_selection"
		);
	} finally {
		await cleanup(fixture);
	}
});

test("pedido de confirmação é enfileirado na nova tentativa após falha no outbox", async () => {
	const fixture = await createFixture("awaiting_slot_selection");
	try {
		const externalId = `wamid.partial.slot.${Date.now()}`;
		await enqueueTask(fixture.conversation.id, SEND_CONFIRMATION_REQUEST_TASK, {
			buttonId: fixture.slot.id,
			eventExternalId: externalId,
		});

		const outbound = await runWithOneOutboxFailure(
			fixture.conversation.id,
			`confirmation-request:${fixture.conversation.id}:${externalId}`
		);

		assert.ok(outbound, "o pedido de confirmação nunca foi enfileirado");
		assert.equal(
			await sessionStage(fixture.session.id),
			"awaiting_confirmation"
		);
	} finally {
		await cleanup(fixture);
	}
});

test("confirmação de agendamento é enfileirada na nova tentativa sem criar outro evento", async (t) => {
	const fixture = await createFixture("awaiting_confirmation");
	await db
		.update(schedulingSessions)
		.set({ selectedSlotId: fixture.slot.id })
		.where(eq(schedulingSessions.id, fixture.session.id));

	let createdEvents = 0;
	t.mock.method(GoogleCalendarService.prototype, "getBusyPeriods", async () => [
		{ busy: [], calendarId: "audit@example.com" },
	]);
	t.mock.method(GoogleCalendarService.prototype, "createEvent", async () => {
		createdEvents += 1;
		return {
			end: fixture.slot.endAt.toISOString(),
			id: `audit-event-${createdEvents}`,
			start: fixture.slot.startAt.toISOString(),
		};
	});
	t.mock.method(GoogleCalendarService.prototype, "deleteEvent", async () => {
		createdEvents -= 1;
	});

	try {
		const externalId = `wamid.partial.confirm.${Date.now()}`;
		await enqueueTask(fixture.conversation.id, PROCESS_BUTTON_REPLY_TASK, {
			buttonId: `confirm:${fixture.slot.id}`,
			eventExternalId: externalId,
		});

		const outbound = await runWithOneOutboxFailure(
			fixture.conversation.id,
			`button-reply:${fixture.conversation.id}:${externalId}`
		);

		assert.ok(outbound, "a confirmação do agendamento nunca foi enfileirada");
		assert.equal(createdEvents, 1);

		const leadAppointments = await db
			.select({ id: appointments.id })
			.from(appointments)
			.where(eq(appointments.leadId, fixture.lead.id));
		assert.equal(leadAppointments.length, 1);
	} finally {
		await cleanup(fixture);
	}
});

test("replay de confirmação não vaza appointment de outro lead", async (t) => {
	const owner = await createFixture("awaiting_confirmation");
	const intruder = await createFixture("awaiting_availability");
	await db
		.update(schedulingSessions)
		.set({ selectedSlotId: owner.slot.id })
		.where(eq(schedulingSessions.id, owner.session.id));

	t.mock.method(GoogleCalendarService.prototype, "getBusyPeriods", async () => [
		{ busy: [], calendarId: "audit@example.com" },
	]);
	t.mock.method(GoogleCalendarService.prototype, "createEvent", async () => ({
		end: owner.slot.endAt.toISOString(),
		id: `audit-event-owner-${Date.now()}`,
		start: owner.slot.startAt.toISOString(),
	}));

	try {
		const handlers = createAutonomousTaskHandlers();
		await enqueueTask(owner.conversation.id, PROCESS_BUTTON_REPLY_TASK, {
			buttonId: `confirm:${owner.slot.id}`,
			eventExternalId: `wamid.owner.${Date.now()}`,
		});
		const ownerRun = await executeNextAutonomousTask({
			conversationId: owner.conversation.id,
			handlers,
		});
		assert.equal(ownerRun.status, "completed");

		const intruderExternalId = `wamid.intruder.${Date.now()}`;
		await enqueueTask(intruder.conversation.id, PROCESS_BUTTON_REPLY_TASK, {
			buttonId: `confirm:${owner.slot.id}`,
			eventExternalId: intruderExternalId,
		});
		const intruderRun = await executeNextAutonomousTask({
			conversationId: intruder.conversation.id,
			handlers,
		});
		assert.equal(intruderRun.status, "completed");

		const intruderOutbound = await db
			.select({ id: outboundMessages.id })
			.from(outboundMessages)
			.where(eq(outboundMessages.conversationId, intruder.conversation.id));
		assert.equal(intruderOutbound.length, 0);
	} finally {
		await cleanup(owner);
		await cleanup(intruder);
	}
});
