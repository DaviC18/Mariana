/** biome-ignore-all lint/suspicious/useAwait: <> */
/**
 * Step 11 — respostas inválidas, duplicadas e fora de ordem (cobertura restante).
 *
 * Casos do plano ainda não cobertos por `session-choice-adversarial.test.ts`:
 *   - `sessao:desconhecido` e toque de slot antigo durante a pendência reenviam
 *     a pergunta, sem efeito colateral de agendamento;
 *   - texto livre durante a pendência não decide; gera lembrete e não processa;
 *   - entrega repetida pelo Meta do mesmo `externalId` não gera segunda resposta.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import fastify from "fastify";
import {
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { closeDatabase, db } from "../../db/connections";
import { autonomousTasks } from "../../db/schema/autonomous-tasks";
import { appointments } from "../../db/schema/appointments";
import { schedulingSessions } from "../../db/schema/scheduling-sessions";
import { conversations } from "../../db/schema/conversations";
import { leads } from "../../db/schema/leads";
import { messages } from "../../db/schema/messages";
import { outboundMessages } from "../../db/schema/outbound-messages";
import { whatsappWebhookEvents } from "../../db/schema/whatsapp-webhook-events";
import { env } from "../../env";
import { webhookWhatsApp } from "../../routes/whatsapp/webhook-whatsapp";
import {
	PROCESS_INBOUND_MESSAGE_TASK,
	REMIND_SESSION_CHOICE_TASK,
} from "../../services/conversations/autonomous-task-handlers";
import { openSessionChoice } from "../../services/conversations/session-choice-store";
import { drainConversationWork } from "../../services/reliability/background-workers";

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

function textWebhook(phone: string, body: string, externalId: string): string {
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

async function post(app: ReturnType<typeof buildApp>, payload: string) {
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

/** Cria lead + conversa + pendência aberta e retorna o estado do fixture. */
async function createPendingFixture() {
	const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const phone = `551192${suffix.slice(-9)}`;
	const [lead] = await db
		.insert(leads)
		.values({
			interestedInConsultant: true,
			name: `Lead Invalid ${suffix}`,
			objective: "consórcio",
			phone,
		})
		.returning({ id: leads.id });
	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({ lastCustomerMessageAt: new Date(), leadId: lead.id })
		.returning({ id: conversations.id });
	assert.ok(conversation);

	// Simula a pergunta já enviada: pendência aberta + 1 mensagem do cliente
	// aguardando processamento.
	await openSessionChoice({
		askedAt: new Date(),
		conversationId: conversation.id,
		leadId: lead.id,
	});
	const [pendingMessage] = await db
		.insert(messages)
		.values({
			content: "mensagem anterior",
			conversationId: conversation.id,
			role: "user",
		})
		.returning({ id: messages.id });
	assert.ok(pendingMessage);

	// Não criar task ASK pendente: o executor só permite a task mais antiga
	// por conversa ser reclamada; ter outra pendente bloquearia o processamento
	// da task de invalidação/resposta que o webhook acaba de enfileirar.

	return {
		conversationId: conversation.id,
		leadId: lead.id,
		pendingMessageId: pendingMessage.id,
		phone,
		suffix,
	};
}

async function conversationStage(conversationId: string) {
	const [row] = await db
		.select({ status: conversations.status })
		.from(conversations)
		.where(eq(conversations.id, conversationId));
	return row?.status;
}

/**
 * Sender fake entregue explicitamente ao drenar o outbox. Evita chamadas de
 * rede reais e evita mutar `WhatsAppService.prototype` (estado global que
 * colide quando os testes do mesmo arquivo rodam em paralelo).
 */
function fakeSender() {
	const sentTexts: string[] = [];
	const sentBodies: string[] = [];
	const sender = {
		sendReplyButtonsMessage: async (to: string, body: string) => {
			sentBodies.push(body);
			return {
				contacts: [{ input: to, wa_id: to }],
				messages: [{ id: `wamid.b_${Date.now()}_${sentBodies.length}` }],
				messaging_product: "whatsapp",
			};
		},
		sendTextMessage: async (to: string, text: string) => {
			sentTexts.push(text);
			return {
				contacts: [{ input: to, wa_id: to }],
				messages: [{ id: `wamid.t_${Date.now()}_${sentTexts.length}` }],
				messaging_product: "whatsapp",
			};
		},
	};
	return { sender, sentBodies, sentTexts };
}

// ---------------------------------------------------------------------------
// toque desconhecido e toque de slot antigo durante a pendência
// ---------------------------------------------------------------------------

test("toque sessao:desconhecido e toque de slot antigo durante a pendência reenviam a pergunta", async () => {
	const app = buildApp();
	const { sender, sentBodies, sentTexts } = fakeSender();

	try {
		const fixture = await createPendingFixture();
		try {
			const staleSlot = "123e4567-e89b-12d3-a456-426614174000";
			const taps = [
				"desconhecido",
				`confirm:${staleSlot}`,
				`slot:${staleSlot}`,
			];

			for (const [index, buttonId] of taps.entries()) {
				const res = await post(
					app,
					buttonWebhook(
						fixture.phone,
						buttonId,
						`wamid.invalid_${index}_${fixture.suffix}`
					)
				);
				assert.equal(res.statusCode, 200);
			}

			// Drena as tasks de sessão e de agendamento que foram enfileiradas.
			await drainConversationWork(fixture.conversationId, { sender });

			// Nenhum appointment, nenhuma sessão de agendamento, estágio intacto.
			const appts = await db
				.select({ id: appointments.id })
				.from(appointments)
				.where(eq(appointments.leadId, fixture.leadId));
			assert.equal(appts.length, 0);

			const sessions = await db
				.select({ id: schedulingSessions.id })
				.from(schedulingSessions)
				.where(eq(schedulingSessions.leadId, fixture.leadId));
			assert.equal(sessions.length, 0);

			assert.equal(await conversationStage(fixture.conversationId), "active");

			// Cada toque inválido recebeu a resposta de pergunta pendente
			// (fingerprint da pergunta/pendência), nunca uma ação de agendamento.
			const delivered = [...sentTexts, ...sentBodies];
			const replies = delivered.filter((text) => text.includes("escolha"));
			assert.equal(replies.length, taps.length);

			// O estado de escolha continua pendente: nada foi decidido.
			const pending = await db
				.select({ id: autonomousTasks.id })
				.from(autonomousTasks)
				.where(
					and(
						eq(autonomousTasks.conversationId, fixture.conversationId),
						eq(
							autonomousTasks.idempotencyKey,
							`session-choice-state:${fixture.conversationId}`
						)
					)
				);
			assert.equal(pending.length, 1);
		} finally {
			await cleanup(fixture.leadId);
		}
	} finally {
		await app.close();
	}
});

// ---------------------------------------------------------------------------
// texto livre durante a pendência (Q4)
// ---------------------------------------------------------------------------

test("texto livre 'quero começar do zero' não cria B; recebe lembrete e não é processado", async () => {
	const app = buildApp();
	const { sender } = fakeSender();

	try {
		const fixture = await createPendingFixture();
		try {
			const externalId = `wamid.freetext_${fixture.suffix}`;
			const res = await post(
				app,
				textWebhook(fixture.phone, "quero começar do zero", externalId)
			);
			assert.equal(res.statusCode, 200);

			await drainConversationWork(fixture.conversationId, { sender });

			// Nenhuma conversa B: apenas A continua ativa.
			const convs = await db
				.select({ id: conversations.id, status: conversations.status })
				.from(conversations)
				.where(eq(conversations.leadId, fixture.leadId));
			assert.equal(convs.length, 1);
			assert.equal(convs[0].id, fixture.conversationId);
			assert.equal(convs[0].status, "active");

			// Task de lembrete enfileirada; mensagem de texto NÃO processada.
			const tasks = await db
				.select({
					status: autonomousTasks.status,
					taskType: autonomousTasks.taskType,
				})
				.from(autonomousTasks)
				.where(eq(autonomousTasks.conversationId, fixture.conversationId));
			const reminders = tasks.filter(
				(t) => t.taskType === REMIND_SESSION_CHOICE_TASK
			);
			assert.equal(reminders.length, 1);

			const inboundForFreeText = tasks.filter(
				(t) => t.taskType === PROCESS_INBOUND_MESSAGE_TASK
			);
			assert.equal(inboundForFreeText.length, 0);

			// A mensagem fica sem processamento (processedAt permanece nulo).
			const [freeMessage] = await db
				.select({
					processedAt: messages.processedAt,
				})
				.from(messages)
				.where(eq(messages.externalId, externalId))
				.limit(1);
			assert.ok(freeMessage);
			assert.equal(freeMessage.processedAt, null);

			// O lembrete foi enviado (uma resposta), sem decidir.
			const outs = await db
				.select({ payload: outboundMessages.payload })
				.from(outboundMessages)
				.where(eq(outboundMessages.conversationId, fixture.conversationId));
			assert.ok(outs.length >= 1);
		} finally {
			await cleanup(fixture.leadId);
		}
	} finally {
		await app.close();
	}
});

// ---------------------------------------------------------------------------
// entrega repetida pelo Meta
// ---------------------------------------------------------------------------

test("a mesma entrega repetida pelo Meta não gera segunda resposta", async () => {
	const app = buildApp();
	const { sender, sentBodies, sentTexts } = fakeSender();

	try {
		const fixture = await createPendingFixture();
		try {
			const externalId = `wamid.dup_tap_${fixture.suffix}_${Date.now()}`;
			const payload = buttonWebhook(fixture.phone, "desconhecido", externalId);

			const first = await post(app, payload);
			assert.equal(first.statusCode, 200);
			const second = await post(app, payload);
			assert.equal(second.statusCode, 200);

			await drainConversationWork(fixture.conversationId, { sender });

			// Um único evento de webhook persistido.
			const events = await db
				.select({ id: whatsappWebhookEvents.id })
				.from(whatsappWebhookEvents)
				.where(eq(whatsappWebhookEvents.externalId, externalId));
			assert.equal(events.length, 1);

			// Uma única task enfileirada para o mesmo externalId.
			const sessionTasks = await db
				.select({ id: autonomousTasks.id })
				.from(autonomousTasks)
				.where(
					and(
						eq(autonomousTasks.conversationId, fixture.conversationId),
						eq(
							autonomousTasks.idempotencyKey,
							`session-choice-invalid:${externalId}`
						)
					)
				);
			assert.equal(sessionTasks.length, 1);

			// Uma única resposta (nenhum segundo envio).
			const outs = await db
				.select({ id: outboundMessages.id, status: outboundMessages.status })
				.from(outboundMessages)
				.where(eq(outboundMessages.conversationId, fixture.conversationId));
			assert.equal(outs.length, 1);
			assert.equal(outs[0].status, "sent");
			assert.equal(
				sentTexts.length + sentBodies.length,
				1,
				"apenas uma entrega ao cliente"
			);
		} finally {
			await cleanup(fixture.leadId);
		}
	} finally {
		await app.close();
	}
});

// ---------------------------------------------------------------------------
// toque válido decide (regressão: node do passo anterior não foi quebrado)
// ---------------------------------------------------------------------------

test("toque sessao:desconhecido não consome a escolha: toque valido ainda decide", async () => {
	const app = buildApp();
	const { sender } = fakeSender();

	try {
		const fixture = await createPendingFixture();
		try {
			const invalid = await post(
				app,
				buttonWebhook(
					fixture.phone,
					"sessao:desconhecido",
					`wamid.mix_inv_${fixture.suffix}`
				)
			);
			assert.equal(invalid.statusCode, 200);
			await drainConversationWork(fixture.conversationId, { sender });

			const valid = await post(
				app,
				buttonWebhook(
					fixture.phone,
					"sessao:continuar",
					`wamid.mix_val_${fixture.suffix}`
				)
			);
			assert.equal(valid.statusCode, 200);
			await drainConversationWork(fixture.conversationId, { sender });

			// A escolha "continuar" foi aplicada: A continua ativa e a mensagem
			// pendente virou task de inbound.
			const convs = await db
				.select({ id: conversations.id, status: conversations.status })
				.from(conversations)
				.where(eq(conversations.leadId, fixture.leadId));
			const active = convs.filter((c) => c.status === "active");
			assert.equal(active.length, 1);
			assert.equal(active[0].id, fixture.conversationId);

			const inbound = await db
				.select({ id: autonomousTasks.id })
				.from(autonomousTasks)
				.where(
					and(
						eq(autonomousTasks.conversationId, fixture.conversationId),
						eq(autonomousTasks.taskType, PROCESS_INBOUND_MESSAGE_TASK)
					)
				);
			assert.equal(inbound.length, 1);
		} finally {
			await cleanup(fixture.leadId);
		}
	} finally {
		await app.close();
	}
});
