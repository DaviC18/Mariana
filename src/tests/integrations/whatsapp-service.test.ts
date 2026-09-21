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
