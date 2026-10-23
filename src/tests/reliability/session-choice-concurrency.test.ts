/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
/**
 * Step 12 — restart, concorrência e duas conversas ativas.
 *
 * Prova o desenho sob falha e paralelismo real (não sequencial):
 *   - estado pendente sobrevive a restart e a escolha ainda é aplicada numa
 *     cadeia de execução nova (`executeNextAutonomousTask`);
 *   - mensagem concorrente ao toque nunca deixa duas conversas ativas;
 *   - dois toques concorrentes produzem uma única B e A fechada;
 *   - task de agendamento `processing` com pendência não produz appointment;
 *   - regressão AC12: 3 mensagens dentro de 24h ficam na mesma conversa;
 *   - `externalId` repetido processado uma única vez.
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

import { ai } from "../../ai/client";
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
import { whatsappWebhookEvents } from "../../db/schema/whatsapp-webhook-events";
import { env } from "../../env";
import { webhookWhatsApp } from "../../routes/whatsapp/webhook-whatsapp";
import {
	createAutonomousTaskHandlers,
	PROCESS_INBOUND_MESSAGE_TASK,
	PROCESS_SESSION_CHOICE_TASK,
	SEND_CONFIRMATION_REQUEST_TASK,
} from "../../services/conversations/autonomous-task-handlers";
import { executeNextAutonomousTask } from "../../services/conversations/autonomous-task-executor";
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

function textWebhook(
	phone: string,
	body: string,
	externalId: string
): string {
	return JSON.stringify({
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
									id: externalId,
									text: { body },
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
}

function buttonWebhook(
	phone: string,
	buttonId: string,
	externalId: string
): string {
	return JSON.stringify({
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
									id: externalId,
									interactive: {
										button_reply: { id: buttonId, title: "x" },
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
}

async function post(
	app: ReturnType<typeof buildApp>,
	payload: string
) {
	return await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": computeSignature(payload),
		},
		method: "POST",
		payload,
		url: "/webhooks/whatsapp",
	});
}

async function createFixture() {
	const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const [lead] = await db
		.insert(leads)
		.values({
			name: `Lead Concurrency ${suffix}`,
			phone: `551191${suffix.slice(-9)}`,
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

async function tapChoice({
	buttonId,
	conversationId,
	externalId,
}: {
	buttonId: string;
	conversationId: string;
	externalId: string;
}) {
	const handler = createAutonomousTaskHandlers()[PROCESS_SESSION_CHOICE_TASK];
	assert.ok(handler);
	const [task] = await db
		.insert(autonomousTasks)
		.values({
			conversationId,
			idempotencyKey: `session-choice:${externalId}`,
			payload: {
				buttonId,
				eventExternalId: externalId,
				kind: "button",
			},
			status: "processing",
			taskType: PROCESS_SESSION_CHOICE_TASK,
		})
		.returning();
	return await handler({
		leaseToken: "t1",
		renewLease: async () => true,
		task,
	} as any);
}

// ---------------------------------------------------------------------------
// restart via cadeia de execução nova
// ---------------------------------------------------------------------------

test("estado pendente sobrevive a restart e executeNextAutonomousTask aplica a escolha", async () => {
	const { conversationId, leadId, suffix } = await createFixture();

	try {
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });
		await db.insert(messages).values({
			content: "pendente",
			conversationId,
			externalId: `wamid.restart_${suffix}`,
			role: "user",
		});

		// "Processo novo": enfileira a task de escolha como o webhook faria e
		// executa pela cadeia do executor (sem cache, estado lido do Postgres).
		await db.insert(autonomousTasks).values({
			availableAt: new Date(Date.now() - 1000),
			conversationId,
			idempotencyKey: `session-choice-restart:${conversationId}`,
			payload: {
				buttonId: "sessao:continuar",
				eventExternalId: `wamid.restart_tap_${suffix}`,
				kind: "button",
			},
			status: "pending",
			taskType: PROCESS_SESSION_CHOICE_TASK,
		});

		const handlers = createAutonomousTaskHandlers();
		const result = await executeNextAutonomousTask({
			conversationId,
			handlers,
		});
		assert.equal(result.status, "completed");

		const [a] = await db
			.select({ status: conversations.status })
			.from(conversations)
			.where(eq(conversations.id, conversationId));
		assert.equal(a?.status, "active");

		const inbound = await db
			.select({ id: autonomousTasks.id })
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, conversationId),
					eq(autonomousTasks.taskType, PROCESS_INBOUND_MESSAGE_TASK)
				)
			);
		assert.equal(inbound.length, 1);
	} finally {
		await cleanup(leadId);
	}
});

// ---------------------------------------------------------------------------
// concorrência real: mensagem x toque
// ---------------------------------------------------------------------------

test("mensagem concorrente ao toque nova nunca deixa duas conversas ativas", async () => {
	const app = buildApp();

	try {
		const phone = `55119${Math.floor(10_000_000 + Math.random() * 90_000_000)}`;
		const first = await post(
			app,
			textWebhook(phone, "oi", `wamid.cc1_${Date.now()}`)
		);
		assert.equal(first.statusCode, 200);

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

		await openSessionChoice({
			askedAt: new Date(),
			conversationId: conversation.id,
			leadId: lead.id,
		});

		// Dispara ao mesmo tempo: toque `sessao:nova` (handler) e um POST de
		// texto concorrente.
		const [tapResult] = await Promise.all([
			tapChoice({
				buttonId: "sessao:nova",
				conversationId: conversation.id,
				externalId: `wamid.cc_tap_${Date.now()}`,
			}),
			post(app, textWebhook(phone, "mensagem nova", `wamid.cc_text_${Date.now()}`)),
		]);
		assert.ok(tapResult !== undefined);

		const convs = await db
			.select({ id: conversations.id, status: conversations.status })
			.from(conversations)
			.where(eq(conversations.leadId, lead.id));
		const active = convs.filter((c) => c.status === "active");
		assert.equal(active.length, 1);

		// A mensagem concorrente está na conversa vencedora (nunca órfã numa
		// conversa fechada).
		const userMessages = await db
			.select({ conversationId: messages.conversationId })
			.from(messages)
			.where(eq(messages.conversationId, active[0].id));
		assert.ok(userMessages.length >= 1);

		await cleanup(lead.id);
	} finally {
		await app.close();
	}
});

// ---------------------------------------------------------------------------
// dois toques concorrentes
// ---------------------------------------------------------------------------

test("dois toques concorrentes produzem uma única B e A fechada", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });
		await db.insert(messages).values({
			content: "pendente",
			conversationId,
			role: "user",
		});

		const [t1, t2] = await Promise.all([
			tapChoice({
				buttonId: "sessao:nova",
				conversationId,
				externalId: `wamid.two_a_${Date.now()}`,
			}),
			tapChoice({
				buttonId: "sessao:nova",
				conversationId,
				externalId: `wamid.two_b_${Date.now()}`,
			}),
		]);

		// Exatamente um claim vence: um cria B, o outro recebe "já registrada".
		const winners = [t1, t2].filter(
			(r) => (r as any)?.newConversation === true
		);
		assert.equal(winners.length, 1);

		const convs = await db
			.select({ id: conversations.id, status: conversations.status })
			.from(conversations)
			.where(eq(conversations.leadId, leadId));
		assert.equal(convs.length, 2);
		assert.equal(convs.filter((c) => c.status === "active").length, 1);
		assert.equal(
			convs.filter((c) => c.id === conversationId && c.status === "closed")
				.length,
			1
		);
	} finally {
		await cleanup(leadId);
	}
});

// ---------------------------------------------------------------------------
// task de agendamento `processing` com pendência
// ---------------------------------------------------------------------------

test("task de agendamento em processing com pendência aberta não produz appointment", async () => {
	const { consultantId, consultantName, conversationId, leadId } =
		await createFixture();

	try {
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
		const [slot] = await db
			.insert(schedulingSlots)
			.values({
				calendarId: "test-calendar",
				consultantId,
				consultantName,
				endAt: new Date(Date.now() + 5_400_000),
				position: 1,
				schedulingSessionId: session.id,
				startAt: new Date(Date.now() + 3_600_000),
			})
			.returning({ id: schedulingSlots.id });
		assert.ok(slot);

		// A pendência abre DEPOIS que a task já estava em processing (a task não
		// pode ser interrompida; a barreira é a rechecagem no handler).
		await db.insert(autonomousTasks).values({
			conversationId,
			idempotencyKey: `send-confirmation:${conversationId}`,
			payload: {
				buttonId: slot.id,
				eventExternalId: `wamid.proc_${Date.now()}`,
			},
			status: "processing",
			taskType: SEND_CONFIRMATION_REQUEST_TASK,
		});
		await openSessionChoice({ askedAt: new Date(), conversationId, leadId });

		const handlers = createAutonomousTaskHandlers();
		const result = await executeNextAutonomousTask({
			conversationId,
			handlers,
		});

		// A task em processing é a única reclamável; ela roda, mas o handler
		// recheca a pendência e não muda a sessão.
		assert.ok(result.status === "completed" || result.status === "idle");

		assert.equal(
			(
				await db
					.select({ id: appointments.id })
					.from(appointments)
					.where(eq(appointments.leadId, leadId))
			).length,
			0
		);
		const [s] = await db
			.select({ workflowStage: schedulingSessions.workflowStage })
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, session.id));
		assert.equal(s?.workflowStage, "awaiting_slot_selection");
	} finally {
		await cleanup(leadId);
	}
});

// ---------------------------------------------------------------------------
// regressão AC12: 3 mensagens dentro de 24h, uma conversa
// ---------------------------------------------------------------------------

test("três mensagens seguidas dentro de 24h continuam na mesma conversa", async () => {
	const app = buildApp();
	const mockedText = JSON.stringify({
		businessAction: "ask_next_qualification_question",
		evidenceUsed: [],
		leadUpdate: { status: "qualifying" },
		nextAction: "continue_qualification",
		reply: "ok",
	});
	const originalGenerate = ai.models.generateContent;

	try {
		(
			ai.models as unknown as {
				generateContent: () => Promise<unknown>;
			}
		).generateContent = async () => ({ text: mockedText });

		const phone = `55119${Math.floor(10_000_000 + Math.random() * 90_000_000)}`;
		for (let i = 0; i < 3; i += 1) {
			const res = await post(
				app,
				textWebhook(phone, `msg ${i}`, `wamid.three_${i}_${Date.now()}`)
			);
			assert.equal(res.statusCode, 200);
		}

		const [lead] = await db
			.select({ id: leads.id })
			.from(leads)
			.where(eq(leads.phone, phone))
			.limit(1);
		assert.ok(lead);
		const convs = await db
			.select({ id: conversations.id, status: conversations.status })
			.from(conversations)
			.where(eq(conversations.leadId, lead.id));
		assert.equal(convs.length, 1);
		assert.equal(convs[0].status, "active");

		// Nenhuma pergunta de escolha disparada.
		const asks = await db
			.select({ id: autonomousTasks.id })
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, convs[0].id),
					eq(autonomousTasks.taskType, "ask_session_choice")
				)
			);
		assert.equal(asks.length, 0);

		await cleanup(lead.id);
	} finally {
		ai.models.generateContent = originalGenerate;
		await app.close();
	}
});

// ---------------------------------------------------------------------------
// externalId repetido
// ---------------------------------------------------------------------------

test("a mesma mensagem com externalId repetido não é processada duas vezes", async () => {
	const app = buildApp();

	try {
		const phone = `55119${Math.floor(10_000_000 + Math.random() * 90_000_000)}`;
		const externalId = `wamid.dup_${Date.now()}`;
		const payload = textWebhook(phone, "duplicada", externalId);

		const first = await post(app, payload);
		assert.equal(first.statusCode, 200);
		// Mesma entrega repetida pelo Meta.
		const second = await post(app, payload);
		assert.equal(second.statusCode, 200);

		const [lead] = await db
			.select({ id: leads.id })
			.from(leads)
			.where(eq(leads.phone, phone))
			.limit(1);
		assert.ok(lead);

		const events = await db
			.select({ id: whatsappWebhookEvents.id })
			.from(whatsappWebhookEvents)
			.where(eq(whatsappWebhookEvents.externalId, externalId));
		assert.equal(events.length, 1);

		const [conversation] = await db
			.select({ id: conversations.id })
			.from(conversations)
			.where(eq(conversations.leadId, lead.id))
			.limit(1);
		assert.ok(conversation);

		const inboundMsgs = await db
			.select({ id: messages.id })
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, conversation.id),
					eq(messages.role, "user")
				)
			);
		assert.equal(inboundMsgs.length, 1);

		const inboundTasks = await db
			.select({ id: autonomousTasks.id })
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, conversation.id),
					eq(autonomousTasks.taskType, PROCESS_INBOUND_MESSAGE_TASK)
				)
			);
		assert.equal(inboundTasks.length, 1);

		await cleanup(lead.id);
	} finally {
		await app.close();
	}
});
