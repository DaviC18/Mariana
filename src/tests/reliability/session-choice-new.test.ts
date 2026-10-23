/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";

import { closeDatabase, db } from "../../db/connections";
import { appointments } from "../../db/schema/appointments";
import { autonomousTasks } from "../../db/schema/autonomous-tasks";
import { consultants } from "../../db/schema/consultants";
import { conversations } from "../../db/schema/conversations";
import { leads } from "../../db/schema/leads";
import { messages } from "../../db/schema/messages";
import { outboundMessages } from "../../db/schema/outbound-messages";
import { schedulingSessions } from "../../db/schema/scheduling-sessions";
import {
	createAutonomousTaskHandlers,
	PROCESS_INBOUND_MESSAGE_TASK,
	PROCESS_SESSION_CHOICE_TASK,
} from "../../services/conversations/autonomous-task-handlers";
import { SESSION_CHOICE_NEW_CONVERSATION_CONFIRMATION_TEXT } from "../../services/conversations/session-choice-policy";
import { openSessionChoice } from "../../services/conversations/session-choice-store";

test.after(async () => {
	await closeDatabase();
});

async function createFixture() {
	const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const [lead] = await db
		.insert(leads)
		.values({
			name: `Lead New ${suffix}`,
			phone: `551197${suffix.slice(-9)}`,
		})
		.returning({ id: leads.id });
	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({ leadId: lead.id })
		.returning({ id: conversations.id });
	assert.ok(conversation);

	const [consultant] = await db
		.select({ id: consultants.id })
		.from(consultants)
		.where(eq(consultants.active, true))
		.limit(1);
	assert.ok(consultant);

	return {
		consultantId: consultant.id,
		conversationId: conversation.id,
		leadId: lead.id,
		suffix,
	};
}

async function cleanup(leadId: string) {
	const convs = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(eq(conversations.leadId, leadId));
	for (const conv of convs) {
		await db
			.delete(outboundMessages)
			.where(eq(outboundMessages.conversationId, conv.id));
		await db
			.delete(autonomousTasks)
			.where(eq(autonomousTasks.conversationId, conv.id));
		await db.delete(messages).where(eq(messages.conversationId, conv.id));
	}
	await db.delete(appointments).where(eq(appointments.leadId, leadId));
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.leadId, leadId));
	await db.delete(conversations).where(eq(conversations.leadId, leadId));
	await db.delete(leads).where(eq(leads.id, leadId));
}

test("nova conversa cria B com o mesmo lead, fecha A sem apagar nada", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });
		await db.insert(messages).values([
			{
				content: "hist1",
				conversationId,
				processedAt: new Date(),
				role: "user",
			},
			{ content: "hist2", conversationId, role: "assistant" },
		]);

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `session-choice:${conversationId}`,
				payload: { buttonId: "sessao:nova", kind: "button" },
				status: "processing",
				taskType: PROCESS_SESSION_CHOICE_TASK,
			})
			.returning();

		await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);

		const [a] = await db
			.select({ status: conversations.status })
			.from(conversations)
			.where(eq(conversations.id, conversationId));
		assert.equal(a?.status, "closed");

		const allMsgs = await db
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.conversationId, conversationId));
		assert.equal(allMsgs.length, 2);

		const convs = await db
			.select({ id: conversations.id, status: conversations.status })
			.from(conversations)
			.where(eq(conversations.leadId, leadId));
		assert.equal(convs.length, 2);
		const active = convs.find((c) => c.status === "active");
		assert.ok(active);
		assert.notEqual(active.id, conversationId);

		const activeCount = convs.filter((c) => c.status === "active").length;
		assert.equal(activeCount, 1);
	} finally {
		await cleanup(leadId);
	}
});

test("mensagens pendentes são movidas para B e processadas lá", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });
		const [m1] = await db
			.insert(messages)
			.values({
				content: "pendente1",
				conversationId,
				role: "user",
			})
			.returning({ id: messages.id });
		const [m2] = await db
			.insert(messages)
			.values({
				content: "pendente2",
				conversationId,
				role: "user",
			})
			.returning({ id: messages.id });

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `session-choice:${conversationId}`,
				payload: { buttonId: "sessao:nova", kind: "button" },
				status: "processing",
				taskType: PROCESS_SESSION_CHOICE_TASK,
			})
			.returning();

		await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);

		const convs = await db
			.select({ id: conversations.id, status: conversations.status })
			.from(conversations)
			.where(eq(conversations.leadId, leadId));
		const b = convs.find((c) => c.status === "active");
		assert.ok(b);

		// check separately
		const [mm1] = await db
			.select({ conversationId: messages.conversationId })
			.from(messages)
			.where(eq(messages.id, m1.id));
		const [mm2] = await db
			.select({ conversationId: messages.conversationId })
			.from(messages)
			.where(eq(messages.id, m2.id));
		assert.equal(mm1?.conversationId, b.id);
		assert.equal(mm2?.conversationId, b.id);

		const tasksA = await db
			.select({ id: autonomousTasks.id })
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, conversationId),
					eq(autonomousTasks.taskType, PROCESS_INBOUND_MESSAGE_TASK)
				)
			);
		assert.equal(tasksA.length, 0);

		const tasksB = await db
			.select({ id: autonomousTasks.id })
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, b.id),
					eq(autonomousTasks.taskType, PROCESS_INBOUND_MESSAGE_TASK)
				)
			);
		assert.equal(tasksB.length, 2);
	} finally {
		await cleanup(leadId);
	}
});

test("a confirmação de conversa nova é enviada e não assume continuação", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });
		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `session-choice:${conversationId}`,
				payload: { buttonId: "sessao:nova", kind: "button" },
				status: "processing",
				taskType: PROCESS_SESSION_CHOICE_TASK,
			})
			.returning();

		await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);

		const convs = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(eq(conversations.leadId, leadId));
		const b = convs.find((c) => c.id !== conversationId);
		assert.ok(b);

		const outs = await db
			.select({ payload: outboundMessages.payload })
			.from(outboundMessages)
			.where(eq(outboundMessages.conversationId, b.id));
		assert.equal(outs.length, 1);
		assert.equal((outs[0].payload as any).kind, "text");
		assert.equal(
			(outs[0].payload as any).text,
			SESSION_CHOICE_NEW_CONVERSATION_CONFIRMATION_TEXT
		);
	} finally {
		await cleanup(leadId);
	}
});

test("sessão de agendamento ativa de A é expirada e o appointment não é apagado", async () => {
	const { conversationId, consultantId, leadId } = await createFixture();

	try {
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });
		const [session] = await db
			.insert(schedulingSessions)
			.values({
				conversationId,
				expiresAt: new Date(Date.now() + 3_600_000),
				leadId,
				status: "active",
				workflowStage: "awaiting_slot_selection",
			})
			.returning({ id: schedulingSessions.id });
		assert.ok(session);

		const [appt] = await db
			.insert(appointments)
			.values({
				consultantId,
				endAt: new Date(Date.now() + 5_400_000),
				externalEventId: `evt-sched-${Date.now()}-${Math.random()}`,
				leadId,
				startAt: new Date(Date.now() + 3_600_000),
				status: "scheduled",
			})
			.returning({ id: appointments.id });
		assert.ok(appt);

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `session-choice:${conversationId}`,
				payload: { buttonId: "sessao:nova", kind: "button" },
				status: "processing",
				taskType: PROCESS_SESSION_CHOICE_TASK,
			})
			.returning();

		await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);

		const [s] = await db
			.select({ status: schedulingSessions.status })
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, session.id));
		assert.equal(s?.status, "expired");

		const [a] = await db
			.select({ id: appointments.id })
			.from(appointments)
			.where(eq(appointments.id, appt.id));
		assert.ok(a);
	} finally {
		await cleanup(leadId);
	}
});

test("B herda opt-out e janela do cliente", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });
		const now = new Date();
		await db
			.update(conversations)
			.set({ lastCustomerMessageAt: now, optOutAt: now })
			.where(eq(conversations.id, conversationId));

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `session-choice:${conversationId}`,
				payload: { buttonId: "sessao:nova", kind: "button" },
				status: "processing",
				taskType: PROCESS_SESSION_CHOICE_TASK,
			})
			.returning();

		await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);

		const convs = await db
			.select({
				id: conversations.id,
				lastCustomerMessageAt: conversations.lastCustomerMessageAt,
				optOutAt: conversations.optOutAt,
			})
			.from(conversations)
			.where(eq(conversations.leadId, leadId));
		const b = convs.find((c) => c.id !== conversationId);
		assert.ok(b);
		assert.ok(b.optOutAt);
		assert.ok(b.lastCustomerMessageAt);
	} finally {
		await cleanup(leadId);
	}
});

test("o estado guarda o snapshot comercial de A antes do reset", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });
		await db
			.update(leads)
			.set({
				commercialApproach: "vehicle_renewal",
				consortiumType: "veículo",
				currentSituation: "preciso trocar",
				interestedInConsultant: true,
				objective: "consórcio de carro",
				painPoint: "trocar o carro",
				qualifiedAt: new Date(),
				status: "qualifying",
				urgency: "short_term",
			})
			.where(eq(leads.id, leadId));

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `session-choice:${conversationId}`,
				payload: { buttonId: "sessao:nova", kind: "button" },
				status: "processing",
				taskType: PROCESS_SESSION_CHOICE_TASK,
			})
			.returning();

		await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);

		const [row] = await db
			.select({ payload: autonomousTasks.payload })
			.from(autonomousTasks)
			.where(
				eq(
					autonomousTasks.idempotencyKey,
					`session-choice-state:${conversationId}`
				)
			);
		const snap = (row?.payload as any)?.snapshot;
		assert.ok(snap);
		assert.equal(snap.objective, "consórcio de carro");
		assert.equal(snap.consortiumType, "veículo");
		assert.equal(snap.interestedInConsultant, true);
		assert.equal(snap.painPoint, "trocar o carro");
		assert.equal(snap.commercialApproach, "vehicle_renewal");
		assert.equal(snap.currentSituation, "preciso trocar");
		assert.equal(snap.urgency, "short_term");
		assert.equal(snap.status, "qualifying");
	} finally {
		await cleanup(leadId);
	}
});

test("B não herda nenhum campo comercial de A", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });
		await db
			.update(leads)
			.set({
				birthDate: new Date("1990-01-01T00:00:00Z"),
				commercialApproach: "vehicle_renewal",
				consortiumType: "veículo",
				currentSituation: "preciso trocar",
				email: "a@b.com",
				interestedInConsultant: true,
				name: "Teste Nome",
				objective: "consórcio de carro",
				painPoint: "trocar o carro",
				qualifiedAt: new Date(),
				status: "qualifying",
				urgency: "short_term",
			})
			.where(eq(leads.id, leadId));

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `session-choice:${conversationId}`,
				payload: { buttonId: "sessao:nova", kind: "button" },
				status: "processing",
				taskType: PROCESS_SESSION_CHOICE_TASK,
			})
			.returning();

		await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);

		const [lead] = await db
			.select({
				birthDate: leads.birthDate,
				commercialApproach: leads.commercialApproach,
				consortiumType: leads.consortiumType,
				currentSituation: leads.currentSituation,
				email: leads.email,
				interestedInConsultant: leads.interestedInConsultant,
				name: leads.name,
				objective: leads.objective,
				painPoint: leads.painPoint,
				qualifiedAt: leads.qualifiedAt,
				urgency: leads.urgency,
			})
			.from(leads)
			.where(eq(leads.id, leadId));

		assert.equal(lead?.objective, null);
		assert.equal(lead?.consortiumType, null);
		assert.equal(lead?.commercialApproach, null);
		assert.equal(lead?.currentSituation, null);
		assert.equal(lead?.painPoint, null);
		assert.equal(lead?.urgency, null);
		assert.equal(lead?.interestedInConsultant, false);
		assert.equal(lead?.qualifiedAt, null);
		assert.equal(lead?.name, "Teste Nome");
		assert.equal(lead?.email, "a@b.com");
		assert.ok(lead?.birthDate);
	} finally {
		await cleanup(leadId);
	}
});

test("lead scheduled com reunião passada volta a new na conversa nova", async () => {
	const { conversationId, consultantId, leadId } = await createFixture();

	try {
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });
		await db
			.update(leads)
			.set({ qualifiedAt: new Date(), status: "scheduled" })
			.where(eq(leads.id, leadId));

		await db.insert(appointments).values({
			consultantId,
			endAt: new Date(Date.now() - 1_800_000),
			externalEventId: `evt-past-${Date.now()}-${Math.random()}`,
			leadId,
			startAt: new Date(Date.now() - 3_600_000),
			status: "scheduled",
		});

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `session-choice:${conversationId}`,
				payload: { buttonId: "sessao:nova", kind: "button" },
				status: "processing",
				taskType: PROCESS_SESSION_CHOICE_TASK,
			})
			.returning();

		await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);

		const [lead] = await db
			.select({ qualifiedAt: leads.qualifiedAt, status: leads.status })
			.from(leads)
			.where(eq(leads.id, leadId));
		assert.equal(lead?.status, "new");
		assert.equal(lead?.qualifiedAt, null);

		// B must not be born in `confirmation` (RC-10): its stage is a fresh
		// one, never `confirmation`, because the lead is no longer `scheduled`.
		const [b] = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(
				and(
					eq(conversations.leadId, leadId),
					eq(conversations.status, "active")
				)
			);
		assert.ok(b);
		const assistantHistory = await db
			.select({ content: messages.content })
			.from(messages)
			.where(
				and(eq(messages.conversationId, b.id), eq(messages.role, "assistant"))
			);
		assert.equal(assistantHistory.length, 0);
	} finally {
		await cleanup(leadId);
	}
});

test("reunião futura confirmada mantém scheduled e não é apagada", async () => {
	const { conversationId, consultantId, leadId } = await createFixture();

	try {
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });
		await db
			.update(leads)
			.set({ status: "scheduled" })
			.where(eq(leads.id, leadId));

		const [appt] = await db
			.insert(appointments)
			.values({
				consultantId,
				endAt: new Date(Date.now() + 9_000_000),
				externalEventId: `evt-confirmed-${Date.now()}-${Math.random()}`,
				leadId,
				startAt: new Date(Date.now() + 7_200_000),
				status: "confirmed",
			})
			.returning({ id: appointments.id });
		assert.ok(appt);

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `session-choice:${conversationId}`,
				payload: { buttonId: "sessao:nova", kind: "button" },
				status: "processing",
				taskType: PROCESS_SESSION_CHOICE_TASK,
			})
			.returning();

		await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);

		const [lead] = await db
			.select({ status: leads.status })
			.from(leads)
			.where(eq(leads.id, leadId));
		assert.equal(lead?.status, "scheduled");

		const [a] = await db
			.select({ id: appointments.id })
			.from(appointments)
			.where(eq(appointments.id, appt.id));
		assert.ok(a);
	} finally {
		await cleanup(leadId);
	}
});

test("reunião futura cancelada não mantém scheduled", async () => {
	const { conversationId, consultantId, leadId } = await createFixture();

	try {
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });
		await db
			.update(leads)
			.set({ status: "scheduled" })
			.where(eq(leads.id, leadId));

		await db.insert(appointments).values({
			consultantId,
			endAt: new Date(Date.now() + 9_000_000),
			externalEventId: `evt-cancelled-${Date.now()}-${Math.random()}`,
			leadId,
			startAt: new Date(Date.now() + 7_200_000),
			status: "cancelled",
		});

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `session-choice:${conversationId}`,
				payload: { buttonId: "sessao:nova", kind: "button" },
				status: "processing",
				taskType: PROCESS_SESSION_CHOICE_TASK,
			})
			.returning();

		await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);

		const [lead] = await db
			.select({ status: leads.status })
			.from(leads)
			.where(eq(leads.id, leadId));
		assert.equal(lead?.status, "new");
	} finally {
		await cleanup(leadId);
	}
});
