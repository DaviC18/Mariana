/** biome-ignore-all lint/suspicious/useAwait: <> */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { eq } from "drizzle-orm";
import fastify from "fastify";
import {
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { db } from "../../db/connections";
import { conversations, leads, messages } from "../../db/schema";
import { env } from "../../env";
import { WhatsAppService } from "../../integrations/whatsapp/whatsapp-service";
import { webhookWhatsApp } from "../../routes/whatsapp/webhook-whatsapp";
import { messageDebounceCoordinator } from "../../services/conversations/receive-customer-message";

function buildApp(loggedStatusEvents?: unknown[]) {
	const app = fastify().withTypeProvider<ZodTypeProvider>();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	if (loggedStatusEvents) {
		app.addHook("onRequest", async (request) => {
			request.log.info = ((event: unknown) => {
				loggedStatusEvents.push(event);
			}) as typeof request.log.info;
		});
	}
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
test("GET /webhooks/whatsapp - validação com token correto retorna challenge", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const response = await app.inject({
		method: "GET",
		url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${env.WHATSAPP_VERIFY_TOKEN}&hub.challenge=TEST_CHALLENGE_123`,
	});

	assert.equal(response.statusCode, 200);
	assert.equal(response.body, "TEST_CHALLENGE_123");
});

test("GET /webhooks/whatsapp - token incorreto retorna HTTP 403 Forbidden", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const response = await app.inject({
		method: "GET",
		url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=WRONG_TOKEN&hub.challenge=TEST_CHALLENGE",
	});

	assert.equal(response.statusCode, 403);
});

test("POST /webhooks/whatsapp - rejeita requisição com assinatura inválida", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payload = JSON.stringify({ object: "whatsapp_business_account" });

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256":
				"sha256=invalid_signature_hex_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
		},
		method: "POST",
		payload,
		url: "/webhooks/whatsapp",
	});

	assert.equal(response.statusCode, 401);
});

async function assertStatusEvent(
	t: test.TestContext,
	status: string,
	errors?: Array<{ code?: number; message?: string; title?: string }>
) {
	const loggedStatusEvents: unknown[] = [];
	const app = buildApp(loggedStatusEvents);
	t.after(() => app.close());

	const statusPayload = JSON.stringify({
		entry: [
			{
				changes: [
					{
						field: "messages",
						value: {
							messaging_product: "whatsapp",
							metadata: {
								display_phone_number: "5511999999999",
								phone_number_id: "12345",
							},
							statuses: [
								{
									id: "wamid.status123",
									recipient_id: "5511988888888",
									status,
									timestamp: "1700000000",
									...(errors ? { errors } : {}),
								},
							],
						},
					},
				],
				id: "entry_1",
			},
		],
		object: "whatsapp_business_account",
	});

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": computeSignature(statusPayload),
		},
		method: "POST",
		payload: statusPayload,
		url: "/webhooks/whatsapp",
	});

	assert.equal(response.statusCode, 200);
	assert.deepEqual(loggedStatusEvents, [
		{
			event: "whatsapp_message_status",
			messageId: "wamid.status123",
			status,
			timestamp: "1700000000",
			recipientId: "5511988888888",
			...(errors ? { errors } : {}),
		},
	]);
}

test("POST /webhooks/whatsapp - registra status sent", async (t) => {
	await assertStatusEvent(t, "sent");
});

test("POST /webhooks/whatsapp - registra status delivered", async (t) => {
	await assertStatusEvent(t, "delivered");
});

test("POST /webhooks/whatsapp - registra status read", async (t) => {
	await assertStatusEvent(t, "read");
});

test("POST /webhooks/whatsapp - registra status failed com erro", async (t) => {
	await assertStatusEvent(t, "failed", [
		{
			code: 131026,
			title: "Message Undeliverable",
			message: "Message undeliverable.",
		},
	]);
});

test("POST /webhooks/whatsapp - evento somente de status retorna HTTP 200", async (t) => {
	await assertStatusEvent(t, "delivered");
});

test("POST /webhooks/whatsapp - fluxo completo: lead, conversation, inbound, debounce/Mariana, outbound e idempotência", async (t) => {
	const app = buildApp();
	t.after(() => {
		app.close();
	});

	const testPhone = `55119${Math.floor(10_000_000 + Math.random() * 90_000_000)}`;
	const inboundWamid = `wamid.inbound_${Date.now()}_${Math.random().toString(36).slice(7)}`;
	const outboundWamid = `wamid.outbound_${Date.now()}_${Math.random().toString(36).slice(7)}`;

	let outboundSentTo: string | undefined;
	let outboundSentText: string | undefined;

	const originalSendTextMessage = WhatsAppService.prototype.sendTextMessage;
	WhatsAppService.prototype.sendTextMessage = async (
		to: string,
		text: string
	) => {
		outboundSentTo = to;
		outboundSentText = text;
		return {
			contacts: [{ input: to, wa_id: to }],
			messages: [{ id: outboundWamid }],
			messaging_product: "whatsapp",
		};
	};

	t.after(() => {
		WhatsAppService.prototype.sendTextMessage = originalSendTextMessage;
	});

	const textPayload = JSON.stringify({
		entry: [
			{
				changes: [
					{
						field: "messages",
						value: {
							contacts: [
								{
									profile: { name: "Cliente Teste WhatsApp" },
									wa_id: testPhone,
								},
							],
							messages: [
								{
									from: testPhone,
									id: inboundWamid,
									text: { body: "Quero saber sobre consórcio de imóveis" },
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

	// 1. Primeiramente envia o webhook POST
	const response1 = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": computeSignature(textPayload),
		},
		method: "POST",
		payload: textPayload,
		url: "/webhooks/whatsapp",
	});

	assert.equal(response1.statusCode, 200);

	// 2. Verifica se o Lead foi criado no DB
	const [createdLead] = await db
		.select()
		.from(leads)
		.where(eq(leads.phone, testPhone))
		.limit(1);

	assert.ok(createdLead, "Lead deveria ter sido criado");
	assert.equal(createdLead.phone, testPhone);
	assert.equal(createdLead.name, "Cliente Teste WhatsApp");

	// 3. Verifica se a Conversation foi criada no DB
	const [createdConversation] = await db
		.select()
		.from(conversations)
		.where(eq(conversations.leadId, createdLead.id))
		.limit(1);

	assert.ok(createdConversation, "Conversation ativa deveria ter sido criada");
	assert.equal(createdConversation.status, "active");

	// 4. Verifica se a mensagem Inbound foi salva com o externalId (wamid) correto
	const [inboundMessage] = await db
		.select()
		.from(messages)
		.where(eq(messages.externalId, inboundWamid))
		.limit(1);

	assert.ok(inboundMessage, "Mensagem inbound deveria estar no banco");
	assert.equal(inboundMessage.conversationId, createdConversation.id);
	assert.equal(inboundMessage.role, "user");
	assert.equal(
		inboundMessage.content,
		"Quero saber sobre consórcio de imóveis"
	);

	// Dispara a execução das mensagens acumuladas no debounce coordinator
	await messageDebounceCoordinator.flush(createdConversation.id);

	// Verifica se a resposta outbound da Mariana foi enviada pelo WhatsAppService e gravada com outboundWamid
	assert.equal(outboundSentTo, testPhone);
	assert.ok(
		typeof outboundSentText === "string" && outboundSentText.length > 0
	);

	const [outboundMessage] = await db
		.select()
		.from(messages)
		.where(eq(messages.externalId, outboundWamid))
		.limit(1);

	assert.ok(
		outboundMessage,
		"Mensagem outbound da Mariana deveria ter sido persistida no banco com externalId"
	);
	assert.equal(outboundMessage.conversationId, createdConversation.id);
	assert.equal(outboundMessage.role, "assistant");

	// 5. Teste de Idempotência: re-envia a mesma mensagem com o mesmo wamid
	const responseDuplicate = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": computeSignature(textPayload),
		},
		method: "POST",
		payload: textPayload,
		url: "/webhooks/whatsapp",
	});

	assert.equal(responseDuplicate.statusCode, 200);

	// Garante que não foi duplicada a mensagem no banco
	const duplicateMessages = await db
		.select()
		.from(messages)
		.where(eq(messages.externalId, inboundWamid));

	assert.equal(duplicateMessages.length, 1);

	// 6. Teste de Reutilização de Lead e Conversation: nova mensagem com novo wamid do mesmo número
	const secondInboundWamid = `wamid.inbound2_${Date.now()}`;
	const secondTextPayload = JSON.stringify({
		entry: [
			{
				changes: [
					{
						field: "messages",
						value: {
							contacts: [{ wa_id: testPhone }],
							messages: [
								{
									from: testPhone,
									id: secondInboundWamid,
									text: { body: "Tenho um valor para dar de entrada" },
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

	const response2 = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": computeSignature(secondTextPayload),
		},
		method: "POST",
		payload: secondTextPayload,
		url: "/webhooks/whatsapp",
	});

	assert.equal(response2.statusCode, 200);

	await messageDebounceCoordinator.flush(createdConversation.id);

	// Garante que não criou lead nem conversa duplicados
	const allLeadsForPhone = await db
		.select()
		.from(leads)
		.where(eq(leads.phone, testPhone));

	assert.equal(allLeadsForPhone.length, 1);

	const allConversationsForLead = await db
		.select()
		.from(conversations)
		.where(eq(conversations.leadId, createdLead.id));

	assert.equal(allConversationsForLead.length, 1);
});
