/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
/**
 * Step 10 — bloqueio de agendamento enquanto a escolha de sessão está pendente.
 *
 * Três camadas previstas no plano (§7):
 *   1. roteamento do webhook manda qualquer botão não-`sessao:` para
 *      `process_session_choice` inválido;
 *   2. `claimNextTask` não reclama tasks que não sejam `session_choice_*`
 *      enquanto existe estado pendente na conversa;
 *   3. os 4 handlers de agendamento rechecam `readPendingSessionChoice` antes
 *      de qualquer efeito externo;
 *   4. ao abrir a pendência, tasks `pending` antigas ficam `completed` com
 *      `result.supersededBy === "session_choice"` e não são apagadas.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { and, eq, inArray } from "drizzle-orm";
import fastify from "fastify";
import {
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { closeDatabase, db } from "../../db/connections";
import { appointments } from "../../db/schema/appointments";
import { autonomousTasks } from "../../db/schema/autonomous-tasks";
import { consultants } from "../../db/schema/consultants";
import { conversations } from "../../db/schema/conversations";
import { leads } from "../../db/schema/leads";
import { messages } from "../../db/schema/messages";
import { outboundMessages } from "../../db/schema/outbound-messages";
import { schedulingSessions } from "../../db/schema/scheduling-sessions";
import { schedulingSlots } from "../../db/schema/scheduling-slots";
import { env } from "../../env";
import { webhookWhatsApp } from "../../routes/whatsapp/webhook-whatsapp";
import {
	createAutonomousTaskHandlers,
	PROCESS_BUTTON_REPLY_TASK,
	PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK,
	PROCESS_CONSULTANT_SELECTION_TASK,
	PROCESS_SESSION_CHOICE_TASK,
	SEND_CONFIRMATION_REQUEST_TASK,
} from "../../services/conversations/autonomous-task-handlers";
import { executeNextAutonomousTask } from "../../services/conversations/autonomous-task-executor";
import { SESSION_CHOICE_PENDING_INVALID_REPLY_TEXT } from "../../services/conversations/session-choice-policy";
import { openSessionChoice } from "../../services/conversations/session-choice-store";

test.after(async () => {
	await closeDatabase();
});

function buildApp() {
	const app = fastify().withTypeProvider<ZodTypeProvider>();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	app.register(webhookWhatsApp);
	return app;
}

function computeSignature(
	payload: string,
	secret: string = env.WHATSAPP_APP_SECRET
): string {
	return (
		"sha256=" +
		crypto.createHmac("sha256", secret).update(payload).digest("hex")
	);
}

async function createFixture() {
	const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const [lead] = await db
		.insert(leads)
		.values({
			name: `Lead Gate ${suffix}`,
			phone: `551193${suffix.slice(-9)}`,
		})
		.returning({ id: leads.id });
	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({ leadId: lead.id })
		.returning({ id: conversations.id });
	assert.ok(conversation);

	const [consultant] = await db
		.select({ id: consultants.id, name: consultants.name })
		.from(consultants)
		.where(eq(consultants.active, true))
		.limit(1);
	assert.ok(consultant);

	return {
		consultantId: consultant.id,
		consultantName: consultant.name,
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
	const convIds = convs.map((c) => c.id);
	if (convIds.length > 0) {
		await db
			.delete(outboundMessages)
			.where(inArray(outboundMessages.conversationId, convIds));
		await db
			.delete(autonomousTasks)
			.where(inArray(autonomousTasks.conversationId, convIds));
		await db.delete(messages).where(inArray(messages.conversationId, convIds));
	}
	await db.delete(appointments).where(eq(appointments.leadId, leadId));
	const sessionRows = await db
		.select({ id: schedulingSessions.id })
		.from(schedulingSessions)
		.where(eq(schedulingSessions.leadId, leadId));
	const sessionIds = sessionRows.map((s) => s.id);
	if (sessionIds.length > 0) {
		await db
			.delete(schedulingSlots)
			.where(inArray(schedulingSlots.schedulingSessionId, sessionIds));
	}
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.leadId, leadId));
	await db.delete(conversations).where(eq(conversations.leadId, leadId));
	await db.delete(leads).where(eq(leads.id, leadId));
}

async function createSlotFixture({
	consultantId,
	consultantName,
	conversationId,
	leadId,
	stage,
}: {
	consultantId: string;
	consultantName: string;
	conversationId: string;
	leadId: string;
	stage: "awaiting_slot_selection" | "awaiting_consultant_preference";
}) {
	const [session] = await db
		.insert(schedulingSessions)
		.values({
			conversationId,
			expiresAt: new Date(Date.now() + 3_600_000),
			leadId,
			status: "active",
			workflowStage: stage,
		})
		.returning({ id: schedulingSessions.id });
	assert.ok(session);

	const [slot] = await db
		.insert(schedulingSlots)
		.values({
			calendarId: "test-calendar",
			consultantId,
			consultantName,
			endAt: new Date(Date.now() + 3_600_000 + 1_800_000),
			position: 1,
			schedulingSessionId: session.id,
			startAt: new Date(Date.now() + 3_600_000),
		})
		.returning({ id: schedulingSlots.id });
	assert.ok(slot);

	return { sessionId: session.id, slotId: slot.id };
}

async function insertProcessingTask({
	conversationId,
	payload,
	taskType,
}: {
	conversationId: string;
	payload: Record<string, unknown>;
	taskType: string;
}) {
	const [task] = await db
		.insert(autonomousTasks)
		.values({
			conversationId,
			idempotencyKey: `${taskType}:${conversationId}:${Date.now()}:${Math.random()}`,
			payload,
			status: "processing",
			taskType,
		})
		.returning();
	assert.ok(task);
	return task;
}

async function countAppointmentsForLead(leadId: string) {
	const rows = await db
		.select({ id: appointments.id })
		.from(appointments)
		.where(eq(appointments.leadId, leadId));
	return rows.length;
}

// ---------------------------------------------------------------------------
// (a) roteamento do webhook durante a pendência
// ---------------------------------------------------------------------------

test("toque de outra família durante a pendência vira process_session_choice inválido e não cria agendamento", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const { consultantId, consultantName, leadId } = await createFixture();
	const phone = `55119${Math.floor(10_000_000 + Math.random() * 90_000_000)}`;

	try {
		// Cria lead/conversa reais via webhook (texto), depois abre a pendência.
		const firstWamid = `wamid.gate_a1_${Date.now()}`;
		const firstPayload = JSON.stringify({
			entry: [
				{
					changes: [
						{
							field: "messages",
							value: {
								contacts: [{ profile: { name: "Cliente" }, wa_id: phone }],
								messages: [
									{
										from: phone,
										id: firstWamid,
										text: { body: "oi" },
										timestamp: String(Math.floor(Date.now() / 1000)),
										type: "text",
									},
								],
								messaging_product: "whatsapp",
								metadata: {
									display_phone_number: "5511999999999",
									phone_number_id: "12345",
								},
							},
						},
					],
					id: "entry_1",
				},
			],
			object: "whatsapp_business_account",
		});
		const r1 = await app.inject({
			headers: {
				"content-type": "application/json",
				"x-hub-signature-256": computeSignature(firstPayload),
			},
			method: "POST",
			payload: firstPayload,
			url: "/webhooks/whatsapp",
		});
		assert.equal(r1.statusCode, 200);

		const [lead] = await db
			.select({ id: leads.id })
			.from(leads)
			.where(eq(leads.phone, phone))
			.limit(1);
		assert.ok(lead);
		const [conversation] = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(eq(conversations.leadId, lead.id))
			.limit(1);
		assert.ok(conversation);

		// Sessão de agendamento ativa com um slot, e a pendência aberta.
		await createSlotFixture({
			consultantId,
			consultantName,
			conversationId: conversation.id,
			leadId: lead.id,
			stage: "awaiting_slot_selection",
		});
		await openSessionChoice({
			askedAt: new Date(),
			conversationId: conversation.id,
			leadId: lead.id,
		});

		const before = await countAppointmentsForLead(lead.id);

		// Toque `confirm:<slot>` durante a pendência.
		const tapWamid = `wamid.gate_a2_${Date.now()}`;
		const slotId = crypto.randomUUID();
		const tapPayload = JSON.stringify({
			entry: [
				{
					changes: [
						{
							field: "messages",
							value: {
								contacts: [{ profile: { name: "Cliente" }, wa_id: phone }],
								messages: [
									{
										from: phone,
										id: tapWamid,
										interactive: {
											button_reply: {
												id: `confirm:${slotId}`,
												title: "Confirmar",
											},
											type: "button_reply",
										},
										timestamp: String(Math.floor(Date.now() / 1000)),
										type: "interactive",
									},
								],
								messaging_product: "whatsapp",
								metadata: {
									display_phone_number: "5511999999999",
									phone_number_id: "12345",
								},
							},
						},
					],
					id: "entry_1",
				},
			],
			object: "whatsapp_business_account",
		});
		const r2 = await app.inject({
			headers: {
				"content-type": "application/json",
				"x-hub-signature-256": computeSignature(tapPayload),
			},
			method: "POST",
			payload: tapPayload,
			url: "/webhooks/whatsapp",
		});
		assert.equal(r2.statusCode, 200);

		// Nenhuma task de agendamento criada.
		const schedulingTasks = await db
			.select({ taskType: autonomousTasks.taskType })
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, conversation.id),
					inArray(autonomousTasks.taskType, [
						PROCESS_BUTTON_REPLY_TASK,
						SEND_CONFIRMATION_REQUEST_TASK,
					])
				)
			);
		assert.equal(schedulingTasks.length, 0);

		// A task criada é process_session_choice e o payload é inválido.
		const choiceTasks = await db
			.select({ payload: autonomousTasks.payload })
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, conversation.id),
					eq(autonomousTasks.taskType, PROCESS_SESSION_CHOICE_TASK)
				)
			);
		assert.equal(choiceTasks.length, 1);
		assert.equal((choiceTasks[0].payload as any).kind, "invalid");

		// Executa o handler e confirma: 0 appointments e resposta de pendência.
		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
		assert.ok(handler);
		const [task] = await db
			.select()
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, conversation.id),
					eq(autonomousTasks.taskType, PROCESS_SESSION_CHOICE_TASK)
				)
			);
		await handler({ leaseToken: "t", renewLease: async () => true, task } as any);

		assert.equal(await countAppointmentsForLead(lead.id), before);

		const outs = await db
			.select({ payload: outboundMessages.payload })
			.from(outboundMessages)
			.where(eq(outboundMessages.conversationId, conversation.id));
		const invalidReplies = outs.filter(
			(o) => (o.payload as any).body === SESSION_CHOICE_PENDING_INVALID_REPLY_TEXT
		);
		assert.equal(invalidReplies.length, 1);
	} finally {
		// cleanup por lead real criado pelo webhook
		const [lead] = await db
			.select({ id: leads.id })
			.from(leads)
			.where(eq(leads.phone, phone))
			.limit(1);
		if (lead) {
			await cleanup(lead.id);
		}
		await cleanup(leadId);
	}
});

// ---------------------------------------------------------------------------
// (b) executor não reclama task de agendamento com pendência aberta
// ---------------------------------------------------------------------------

test("uma task de agendamento enfileirada não é reclamada enquanto a pendência existe", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				availableAt: new Date(Date.now() - 1000),
				conversationId,
				idempotencyKey: `send-confirmation:${conversationId}`,
				payload: { buttonId: crypto.randomUUID() },
				status: "pending",
				taskType: SEND_CONFIRMATION_REQUEST_TASK,
			})
			.returning();
		assert.ok(task);

		let executed = false;
		const result = await executeNextAutonomousTask({
			conversationId,
			handlers: {
				[SEND_CONFIRMATION_REQUEST_TASK]: async () => {
					executed = true;
					return {};
				},
			},
		});

		assert.equal(result.status, "idle");
		assert.equal(executed, false);

		const [after] = await db
			.select({ status: autonomousTasks.status })
			.from(autonomousTasks)
			.where(eq(autonomousTasks.id, task.id));
		assert.equal(after?.status, "pending");
	} finally {
		await cleanup(leadId);
	}
});

// ---------------------------------------------------------------------------
// (c) supersessão de tasks antigas ao abrir a pendência
// ---------------------------------------------------------------------------

test("ao abrir a pendência, tasks antigas ficam superseded e auditáveis", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		const [t1] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `old-1:${conversationId}`,
				payload: {},
				status: "pending",
				taskType: SEND_CONFIRMATION_REQUEST_TASK,
			})
			.returning({ id: autonomousTasks.id });
		const [t2] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `old-2:${conversationId}`,
				payload: {},
				status: "pending",
				taskType: PROCESS_BUTTON_REPLY_TASK,
			})
			.returning({ id: autonomousTasks.id });
		assert.ok(t1 && t2);

		// Reproduz a sequência do webhook: abrir estado e marcar superseded.
		const { markSupersededTasks } = await import(
			"../../services/conversations/session-choice-store"
		);
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });
		const marked = await markSupersededTasks({ conversationId });
		assert.equal(marked, 2);

		const rows = await db
			.select({
				id: autonomousTasks.id,
				result: autonomousTasks.result,
				status: autonomousTasks.status,
			})
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, conversationId),
					eq(autonomousTasks.status, "completed")
				)
			);

		const superseded = rows.filter(
			(r) => (r.result as any)?.supersededBy === "session_choice"
		);
		assert.equal(superseded.length, 2);

		// Nenhuma apagada.
		const remaining = await db
			.select({ id: autonomousTasks.id })
			.from(autonomousTasks)
			.where(eq(autonomousTasks.conversationId, conversationId));
		assert.equal(remaining.length, 3); // 2 antigas + a linha de estado
	} finally {
		await cleanup(leadId);
	}
});

// ---------------------------------------------------------------------------
// (d) os 4 handlers de agendamento rechecam a pendência
// ---------------------------------------------------------------------------

test("process_button_reply com confirm:<slot> durante a pendência não cria appointment e devolve o texto de pendência", async () => {
	const { consultantId, consultantName, conversationId, leadId } =
		await createFixture();

	try {
		const { sessionId, slotId } = await createSlotFixture({
			consultantId,
			consultantName,
			conversationId,
			leadId,
			stage: "awaiting_slot_selection",
		});
		await db
			.update(schedulingSessions)
			.set({ selectedSlotId: slotId })
			.where(eq(schedulingSessions.id, sessionId));
		await db
			.update(leads)
			.set({ status: "qualified" })
			.where(eq(leads.id, leadId));
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_BUTTON_REPLY_TASK];
		assert.ok(handler);

		const task = await insertProcessingTask({
			conversationId,
			payload: {
				buttonId: `confirm:${slotId}`,
				eventExternalId: `wamid.pending_confirm_${Date.now()}`,
				kind: "button_reply",
			},
			taskType: PROCESS_BUTTON_REPLY_TASK,
		});

		await handler({ leaseToken: "t", renewLease: async () => true, task } as any);

		// Nenhum appointment criado (a barreira é a pendência, não a etapa).
		assert.equal(await countAppointmentsForLead(leadId), 0);

		// A impressão digital da barreira: resposta determinística de pendência
		// com os dois botões. Sem a rechecagem, o handler apenas rejeitaria em
		// silêncio (sem outbound).
		const outs = await db
			.select({ payload: outboundMessages.payload })
			.from(outboundMessages)
			.where(eq(outboundMessages.conversationId, conversationId));
		const pendingReplies = outs.filter(
			(o) => (o.payload as any).body === SESSION_CHOICE_PENDING_INVALID_REPLY_TEXT
		);
		assert.equal(pendingReplies.length, 1);
		assert.equal((pendingReplies[0].payload as any).kind, "buttons");

		const [session] = await db
			.select({ selectedSlotId: schedulingSessions.selectedSlotId })
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, sessionId));
		assert.equal(session?.selectedSlotId, slotId);
	} finally {
		await cleanup(leadId);
	}
});

test("process_consultant_preference_reply durante a pendência não muda a sessão", async () => {
	const { consultantId, consultantName, conversationId, leadId } =
		await createFixture();

	try {
		const { sessionId } = await createSlotFixture({
			consultantId,
			consultantName,
			conversationId,
			leadId,
			stage: "awaiting_consultant_preference",
		});
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK];
		assert.ok(handler);

		const task = await insertProcessingTask({
			conversationId,
			payload: {
				buttonId: `pref:${sessionId}:no_preference`,
				eventExternalId: `wamid.pending_pref_${Date.now()}`,
			},
			taskType: PROCESS_CONSULTANT_PREFERENCE_REPLY_TASK,
		});

		await handler({ leaseToken: "t", renewLease: async () => true, task } as any);

		const [session] = await db
			.select({ workflowStage: schedulingSessions.workflowStage })
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, sessionId));
		assert.equal(session?.workflowStage, "awaiting_consultant_preference");
	} finally {
		await cleanup(leadId);
	}
});

test("process_consultant_selection durante a pendência não muda a sessão", async () => {
	const { consultantId, consultantName, conversationId, leadId } =
		await createFixture();

	try {
		const { sessionId } = await createSlotFixture({
			consultantId,
			consultantName,
			conversationId,
			leadId,
			stage: "awaiting_consultant_preference",
		});
		await db
			.update(schedulingSessions)
			.set({ workflowStage: "awaiting_consultant_selection" })
			.where(eq(schedulingSessions.id, sessionId));
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_CONSULTANT_SELECTION_TASK];
		assert.ok(handler);

		const task = await insertProcessingTask({
			conversationId,
			payload: {
				buttonId: `consultant:${sessionId}:${consultantId}`,
				eventExternalId: `wamid.pending_cons_${Date.now()}`,
			},
			taskType: PROCESS_CONSULTANT_SELECTION_TASK,
		});

		await handler({ leaseToken: "t", renewLease: async () => true, task } as any);

		const [session] = await db
			.select({ workflowStage: schedulingSessions.workflowStage })
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, sessionId));
		assert.equal(session?.workflowStage, "awaiting_consultant_selection");
	} finally {
		await cleanup(leadId);
	}
});

test("send_confirmation_request durante a pendência não muda a sessão nem envia pedido; lembrete de escolha é enviado", async () => {
	const { consultantId, consultantName, conversationId, leadId } =
		await createFixture();

	try {
		const { sessionId, slotId } = await createSlotFixture({
			consultantId,
			consultantName,
			conversationId,
			leadId,
			stage: "awaiting_slot_selection",
		});
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[SEND_CONFIRMATION_REQUEST_TASK];
		assert.ok(handler);

		const task = await insertProcessingTask({
			conversationId,
			payload: {
				buttonId: slotId,
				eventExternalId: `wamid.pending_slot_${Date.now()}`,
			},
			taskType: SEND_CONFIRMATION_REQUEST_TASK,
		});

		await handler({ leaseToken: "t", renewLease: async () => true, task } as any);

		const [session] = await db
			.select({ workflowStage: schedulingSessions.workflowStage })
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, sessionId));
		assert.equal(session?.workflowStage, "awaiting_slot_selection");

		const outs = await db
			.select({ payload: outboundMessages.payload })
			.from(outboundMessages)
			.where(eq(outboundMessages.conversationId, conversationId));
		// 1 reminder de escolha de sessão (com botões sessao:continuar / sessao:nova)
		assert.equal(outs.length, 1);
		const payload = outs[0].payload as {
			kind: string;
			body?: string;
			buttons?: Array<{ id: string; title: string }>;
		};
		assert.equal(payload.kind, "buttons");
		assert.ok(payload.body?.includes("Antes de seguir, preciso da sua escolha"));
		assert.equal(payload.buttons?.length, 2);
		const buttonIds = payload.buttons?.map((b) => b.id) ?? [];
		assert.ok(buttonIds.includes("sessao:continuar"));
		assert.ok(buttonIds.includes("sessao:nova"));

		// Nenhum appointment criado
		const appts = await db
			.select({ id: appointments.id })
			.from(appointments)
			.where(eq(appointments.leadId, leadId));
		assert.equal(appts.length, 0);

		// Idempotência: re-executar não envia segundo lembrete
		await handler({ leaseToken: "t", renewLease: async () => true, task } as any);
		const outs2 = await db
			.select({ payload: outboundMessages.payload })
			.from(outboundMessages)
			.where(eq(outboundMessages.conversationId, conversationId));
		assert.equal(outs2.length, 1);
	} finally {
		await cleanup(leadId);
	}
});

// ---------------------------------------------------------------------------
// (e) regressão: depois de resolver, o agendamento volta a funcionar
// ---------------------------------------------------------------------------

test("depois de resolver a pendência, o fluxo de agendamento volta a funcionar", async () => {
	const { consultantId, consultantName, conversationId, leadId } =
		await createFixture();

	try {
		const { sessionId, slotId } = await createSlotFixture({
			consultantId,
			consultantName,
			conversationId,
			leadId,
			stage: "awaiting_slot_selection",
		});
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });

		// Resolve via toque `sessao:continuar`.
		const choiceHandler = createAutonomousTaskHandlers()[
			PROCESS_SESSION_CHOICE_TASK
		];
		assert.ok(choiceHandler);
		const choiceTask = await insertProcessingTask({
			conversationId,
			payload: {
				buttonId: "sessao:continuar",
				eventExternalId: `wamid.gate_e1_${Date.now()}`,
				kind: "button",
			},
			taskType: PROCESS_SESSION_CHOICE_TASK,
		});
		await choiceHandler({
			leaseToken: "t",
			renewLease: async () => true,
			task: choiceTask,
		} as any);

		// Agora a pendência está resolvida: o handler de slot deve rodar.
		const slotHandler =
			createAutonomousTaskHandlers()[SEND_CONFIRMATION_REQUEST_TASK];
		assert.ok(slotHandler);
		const slotTask = await insertProcessingTask({
			conversationId,
			payload: {
				buttonId: slotId,
				eventExternalId: `wamid.gate_e2_${Date.now()}`,
			},
			taskType: SEND_CONFIRMATION_REQUEST_TASK,
		});
		const result = await slotHandler({
			leaseToken: "t",
			renewLease: async () => true,
			task: slotTask,
		} as any);

		assert.equal((result as any)?.confirmationRequestSent, true);

		const [session] = await db
			.select({ workflowStage: schedulingSessions.workflowStage })
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, sessionId));
		assert.equal(session?.workflowStage, "awaiting_confirmation");
	} finally {
		await cleanup(leadId);
	}
});
