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
import { SchedulingChoiceService } from "../../services/calendar/scheduling-choice-service";
import { messageDebounceCoordinator } from "../../services/conversations/receive-customer-message";

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

	const payload = JSON.stringify({
		object: "whatsapp_business_account",
	});

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

test("POST /webhooks/whatsapp - ignora eventos não relevantes rapidamente com status 200", async (t) => {
	const app = buildApp();

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
									status: "delivered",
									timestamp: "1700000000",
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
});

test("POST /webhooks/whatsapp - fluxo completo: lead, conversation, inbound, debounce/Mariana, outbound e idempotência", async (t) => {
	const app = buildApp();

	t.after(() => {
		app.close();
	});

	const testPhone = `55119${Math.floor(
		10_000_000 + Math.random() * 90_000_000
	)}`;

	const inboundWamid = `wamid.inbound_${Date.now()}_${Math.random()
		.toString(36)
		.slice(7)}`;

	const outboundWamid = `wamid.outbound_${Date.now()}_${Math.random()
		.toString(36)
		.slice(7)}`;

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
									profile: {
										name: "Cliente Teste WhatsApp",
									},
									wa_id: testPhone,
								},
							],
							messages: [
								{
									from: testPhone,
									id: inboundWamid,
									text: {
										body: "Quero saber sobre consórcio de imóveis",
									},
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

	const [createdLead] = await db
		.select()
		.from(leads)
		.where(eq(leads.phone, testPhone))
		.limit(1);

	assert.ok(createdLead, "Lead deveria ter sido criado");

	assert.equal(createdLead.phone, testPhone);
	assert.equal(createdLead.name, "Cliente Teste WhatsApp");

	const [createdConversation] = await db
		.select()
		.from(conversations)
		.where(eq(conversations.leadId, createdLead.id))
		.limit(1);

	assert.ok(createdConversation, "Conversation ativa deveria ter sido criada");

	assert.equal(createdConversation.status, "active");

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

	await messageDebounceCoordinator.flush(createdConversation.id);

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

	const duplicateMessages = await db
		.select()
		.from(messages)
		.where(eq(messages.externalId, inboundWamid));

	assert.equal(duplicateMessages.length, 1);

	const secondInboundWamid = `wamid.inbound2_${Date.now()}`;

	const secondTextPayload = JSON.stringify({
		entry: [
			{
				changes: [
					{
						field: "messages",
						value: {
							contacts: [
								{
									wa_id: testPhone,
								},
							],
							messages: [
								{
									from: testPhone,
									id: secondInboundWamid,
									text: {
										body: "Tenho um valor para dar de entrada",
									},
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

test("POST /webhooks/whatsapp - button_reply válido envia confirmação com Confirmar e Não sem passar pelo fluxo conversacional", async (t) => {
	const app = buildApp();

	t.after(() => app.close());

	const testPhone = `55119${Math.floor(
		10_000_000 + Math.random() * 90_000_000
	)}`;

	const buttonWamid = `wamid.button_${Date.now()}_${Math.random()
		.toString(36)
		.slice(7)}`;

	const buttonId = crypto.randomUUID();
	const sessionId = crypto.randomUUID();

	let receivedChoiceInput:
		| Parameters<SchedulingChoiceService["resolveChoice"]>[0]
		| undefined;

	let outboundSentTo: string | undefined;

	let outboundSentBody: string | undefined;

	let outboundSentButtons:
		| Array<{
				id: string;
				title: string;
		  }>
		| undefined;

	const originalResolveChoice = SchedulingChoiceService.prototype.resolveChoice;

	const originalSendReplyButtonsMessage =
		WhatsAppService.prototype.sendReplyButtonsMessage;

	SchedulingChoiceService.prototype.resolveChoice = async (input) => {
		receivedChoiceInput = input;

		return {
			ok: true,
			session: {
				id: sessionId,
			},
			slot: {
				consultantName: "João Silva",
				id: buttonId,
				startAt: new Date("2026-09-29T10:00:00-03:00"),
			},
		} as Awaited<ReturnType<SchedulingChoiceService["resolveChoice"]>>;
	};

	WhatsAppService.prototype.sendReplyButtonsMessage = async (
		to,
		body,
		buttons
	) => {
		outboundSentTo = to;
		outboundSentBody = body;
		outboundSentButtons = buttons;

		return {
			contacts: [
				{
					input: to,
					wa_id: to,
				},
			],
			messages: [
				{
					id: `wamid.confirmation_${Date.now()}`,
				},
			],
			messaging_product: "whatsapp",
		};
	};

	t.after(() => {
		SchedulingChoiceService.prototype.resolveChoice = originalResolveChoice;

		WhatsAppService.prototype.sendReplyButtonsMessage =
			originalSendReplyButtonsMessage;
	});

	const [lead] = await db
		.insert(leads)
		.values({
			consortiumType: "geral",
			name: "Cliente Teste Button",
			objective: "geral",
			phone: testPhone,
		})
		.returning();

	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({
			leadId: lead.id,
		})
		.returning();

	assert.ok(conversation);

	const payload = JSON.stringify({
		entry: [
			{
				changes: [
					{
						field: "messages",
						value: {
							contacts: [
								{
									profile: {
										name: "Cliente Teste Button",
									},
									wa_id: testPhone,
								},
							],
							messages: [
								{
									from: testPhone,
									id: buttonWamid,
									interactive: {
										button_reply: {
											id: buttonId,
											title: "10:00 - João Silva",
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
				id: "entry_button_test",
			},
		],
		object: "whatsapp_business_account",
	});

	try {
		const response = await app.inject({
			headers: {
				"content-type": "application/json",
				"x-hub-signature-256": computeSignature(payload),
			},
			method: "POST",
			payload,
			url: "/webhooks/whatsapp",
		});

		assert.equal(response.statusCode, 200);

		assert.deepEqual(receivedChoiceInput, {
			buttonId,
			conversationId: conversation.id,
			leadId: lead.id,
		});

		assert.equal(outboundSentTo, testPhone);

		assert.equal(
			outboundSentBody,
			"Você escolheu Terça-feira, 29 de setembro às 10:00 com João Silva. Posso confirmar?"
		);

		assert.deepEqual(outboundSentButtons, [
			{
				id: `confirm:${buttonId}`,
				title: "Confirmar",
			},
			{
				id: `cancel:${buttonId}`,
				title: "Não",
			},
		]);

		const buttonMessages = await db
			.select()
			.from(messages)
			.where(eq(messages.externalId, buttonWamid));

		assert.equal(
			buttonMessages.length,
			0,
			"button_reply não deveria passar pelo receiveCustomerMessage"
		);
	} finally {
		await db.delete(conversations).where(eq(conversations.id, conversation.id));

		await db.delete(leads).where(eq(leads.id, lead.id));
	}
});

test("POST /webhooks/whatsapp - button_reply rejeitado pelo SchedulingChoiceService não envia confirmação nem entra no fluxo conversacional", async (t) => {
	const app = buildApp();

	t.after(() => app.close());

	const testPhone = `55119${Math.floor(
		10_000_000 + Math.random() * 90_000_000
	)}`;

	const buttonWamid = `wamid.button_rejected_${Date.now()}_${Math.random()
		.toString(36)
		.slice(7)}`;

	const buttonId = crypto.randomUUID();

	let receivedChoiceInput:
		| Parameters<SchedulingChoiceService["resolveChoice"]>[0]
		| undefined;

	let outboundSendCalled = false;

	const originalResolveChoice = SchedulingChoiceService.prototype.resolveChoice;

	const originalSendReplyButtonsMessage =
		WhatsAppService.prototype.sendReplyButtonsMessage;

	SchedulingChoiceService.prototype.resolveChoice = async (input) => {
		receivedChoiceInput = input;

		return {
			ok: false,
			reason: "expired",
		};
	};

	WhatsAppService.prototype.sendReplyButtonsMessage = async () => {
		outboundSendCalled = true;

		return {
			contacts: [],
			messages: [
				{
					id: "wamid.should_not_exist",
				},
			],
			messaging_product: "whatsapp",
		};
	};

	t.after(() => {
		SchedulingChoiceService.prototype.resolveChoice = originalResolveChoice;

		WhatsAppService.prototype.sendReplyButtonsMessage =
			originalSendReplyButtonsMessage;
	});

	const [lead] = await db
		.insert(leads)
		.values({
			consortiumType: "geral",
			name: "Cliente Teste Button Rejected",
			objective: "geral",
			phone: testPhone,
		})
		.returning();

	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({
			leadId: lead.id,
		})
		.returning();

	assert.ok(conversation);

	const payload = JSON.stringify({
		entry: [
			{
				changes: [
					{
						field: "messages",
						value: {
							contacts: [
								{
									profile: {
										name: "Cliente Teste Button Rejected",
									},
									wa_id: testPhone,
								},
							],
							messages: [
								{
									from: testPhone,
									id: buttonWamid,
									interactive: {
										button_reply: {
											id: buttonId,
											title: "Horário expirado",
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
				id: "entry_button_rejected_test",
			},
		],
		object: "whatsapp_business_account",
	});

	try {
		const response = await app.inject({
			headers: {
				"content-type": "application/json",
				"x-hub-signature-256": computeSignature(payload),
			},
			method: "POST",
			payload,
			url: "/webhooks/whatsapp",
		});

		assert.equal(response.statusCode, 200);

		assert.deepEqual(receivedChoiceInput, {
			buttonId,
			conversationId: conversation.id,
			leadId: lead.id,
		});

		assert.equal(
			outboundSendCalled,
			false,
			"button_reply rejeitado não deveria enviar confirmação"
		);

		const buttonMessages = await db
			.select()
			.from(messages)
			.where(eq(messages.externalId, buttonWamid));

		assert.equal(
			buttonMessages.length,
			0,
			"button_reply rejeitado não deveria passar pelo fluxo conversacional"
		);
	} finally {
		await db.delete(conversations).where(eq(conversations.id, conversation.id));

		await db.delete(leads).where(eq(leads.id, lead.id));
	}
});
