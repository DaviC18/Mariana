/** biome-ignore-all lint/suspicious/useAwait: <> */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { WhatsAppClient } from "../../integrations/whatsapp/whatsapp-client";
import { WhatsAppService } from "../../integrations/whatsapp/whatsapp-service";

test("WhatsAppClient envia mensagem de texto com sucesso", async (t) => {
	const originalFetch = globalThis.fetch;
	let capturedUrl = "";
	let capturedOptions: RequestInit | undefined;

	globalThis.fetch = (async (url: string | URL, options?: RequestInit) => {
		capturedUrl = url.toString();
		capturedOptions = options;
		return new Response(
			JSON.stringify({
				contacts: [{ input: "5511999999999", wa_id: "5511999999999" }],
				messages: [{ id: "wamid.test12345" }],
				messaging_product: "whatsapp",
			}),
			{ headers: { "Content-Type": "application/json" }, status: 200 }
		);
	}) as typeof fetch;

	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	const client = new WhatsAppClient({
		accessToken: "test_access_token",
		apiVersion: "v25.0",
		phoneNumberId: "123456789",
	});

	const res = await client.sendTextMessage("5511999999999", "Olá Mariana!");

	assert.equal(
		capturedUrl,
		"https://graph.facebook.com/v25.0/123456789/messages"
	);
	assert.equal(capturedOptions?.method, "POST");

	const headers = capturedOptions?.headers as Record<string, string>;
	assert.equal(headers.Authorization, "Bearer test_access_token");
	assert.equal(headers["Content-Type"], "application/json");

	const body = JSON.parse(capturedOptions?.body as string);
	assert.equal(body.to, "5511999999999");
	assert.equal(body.text.body, "Olá Mariana!");
	assert.equal(res.messages[0]?.id, "wamid.test12345");
});

test("WhatsAppClient envia Reply Button com um botão", async (t) => {
	const originalFetch = globalThis.fetch;
	let capturedUrl = "";
	let capturedOptions: RequestInit | undefined;

	globalThis.fetch = (async (url: string | URL, options?: RequestInit) => {
		capturedUrl = url.toString();
		capturedOptions = options;
		return new Response(
			JSON.stringify({
				contacts: [{ input: "5511999999999", wa_id: "5511999999999" }],
				messages: [{ id: "wamid.buttons12345" }],
				messaging_product: "whatsapp",
			}),
			{ headers: { "Content-Type": "application/json" }, status: 200 }
		);
	}) as typeof fetch;

	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	const client = new WhatsAppClient({
		accessToken: "test_access_token",
		apiVersion: "v25.0",
		phoneNumberId: "123456789",
	});
	const res = await client.sendReplyButtonsMessage(
		"5511999999999",
		"Escolha um horário",
		[{ id: "schedule:slot:1", title: "25/09 às 14:00" }]
	);

	assert.equal(
		capturedUrl,
		"https://graph.facebook.com/v25.0/123456789/messages"
	);
	assert.equal(capturedOptions?.method, "POST");
	const headers = capturedOptions?.headers as Record<string, string>;
	assert.equal(headers.Authorization, "Bearer test_access_token");
	assert.equal(headers["Content-Type"], "application/json");
	const payload = JSON.parse(capturedOptions?.body as string);
	assert.equal(payload.messaging_product, "whatsapp");
	assert.equal(payload.recipient_type, "individual");
	assert.equal(payload.to, "5511999999999");
	assert.equal(payload.type, "interactive");
	assert.equal(payload.interactive.type, "button");
	assert.equal(payload.interactive.body.text, "Escolha um horário");
	assert.deepEqual(payload.interactive.action.buttons, [
		{
			reply: { id: "schedule:slot:1", title: "25/09 às 14:00" },
			type: "reply",
		},
	]);
	assert.equal(res.messages[0]?.id, "wamid.buttons12345");
});

test("WhatsAppClient preserva três Reply Buttons", async (t) => {
	const originalFetch = globalThis.fetch;
	let capturedOptions: RequestInit | undefined;

	globalThis.fetch = (async (_url: string | URL, options?: RequestInit) => {
		capturedOptions = options;
		return new Response(
			JSON.stringify({
				contacts: [],
				messages: [{ id: "wamid.threebuttons" }],
				messaging_product: "whatsapp",
			}),
			{ headers: { "Content-Type": "application/json" }, status: 200 }
		);
	}) as typeof fetch;

	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	const buttons = [
		{ id: "schedule:slot:1", title: "25/09 às 09:00" },
		{ id: "schedule:slot:2", title: "25/09 às 14:00" },
		{ id: "schedule:slot:3", title: "26/09 às 10:00" },
	];
	await new WhatsAppClient().sendReplyButtonsMessage(
		"5511999999999",
		"Escolha um horário",
		buttons
	);

	const payload = JSON.parse(capturedOptions?.body as string);
	assert.equal(payload.interactive.action.buttons.length, 3);
	assert.deepEqual(
		payload.interactive.action.buttons.map(
			(button: { reply: { id: string; title: string } }) => button.reply
		),
		buttons
	);
});

test("WhatsAppClient lança erro amigável em caso de falha na API HTTP", async (t) => {
	const originalFetch = globalThis.fetch;

	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			statusText: "Unauthorized",
		})) as typeof fetch;

	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	const client = new WhatsAppClient();

	await assert.rejects(
		async () => {
			await client.sendTextMessage("5511999999999", "Teste erro");
		},
		{
			message: "WhatsApp API HTTP 401: Unauthorized",
			name: "Error",
		}
	);
});

test("WhatsAppClient mantém o erro HTTP ao enviar Reply Buttons", async (t) => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			statusText: "Unauthorized",
		})) as typeof fetch;

	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	await assert.rejects(
		async () => {
			await new WhatsAppClient().sendReplyButtonsMessage(
				"5511999999999",
				"Teste erro",
				[{ id: "schedule:slot:1", title: "25/09 às 14:00" }]
			);
		},
		{ message: "WhatsApp API HTTP 401: Unauthorized", name: "Error" }
	);
});

test("WhatsAppService valida assinaturas HMAC-SHA256 corretamente", () => {
	const appSecret = "secret_key_123";
	const service = new WhatsAppService(undefined, appSecret);

	const rawBody = JSON.stringify({ event: "test" });
	const signature = crypto
		.createHmac("sha256", appSecret)
		.update(rawBody)
		.digest("hex");

	const validHeader = `sha256=${signature}`;
	const invalidHeader =
		"sha256=invalid_signature_hex_1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

	assert.equal(service.verifySignature(rawBody, validHeader), true);
	assert.equal(service.verifySignature(rawBody, invalidHeader), false);
	assert.equal(service.verifySignature(rawBody, undefined), false);
});
