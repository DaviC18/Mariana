/** biome-ignore-all lint/suspicious/useAwait: <> */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { WhatsAppClient } from "../../integrations/whatsapp/whatsapp-client";
import { WhatsAppSendError } from "../../integrations/whatsapp/whatsapp-errors";
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
		(error: unknown) => {
			assert.ok(error instanceof WhatsAppSendError);
			assert.equal(error.kind, "permanent");
			assert.equal(error.httpStatus, 401);
			assert.equal(error.retryable, false);
			return true;
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
		(error: unknown) => {
			assert.ok(error instanceof WhatsAppSendError);
			assert.equal(error.kind, "permanent");
			assert.equal(error.httpStatus, 401);
			return true;
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

// fetch que nunca resolve e ignora o AbortSignal: o pior caso de um socket
// pendurado. O cliente ainda precisa liberar o worker no timeout.
function installHangingFetch(t: { after: (fn: () => void) => void }) {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (() => {
		calls += 1;
		return new Promise<Response>(() => undefined);
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	return () => calls;
}

function failAfter(ms: number): Promise<never> {
	return new Promise((_, reject) => {
		setTimeout(
			() => reject(new Error(`still pending after ${ms}ms`)),
			ms
		).unref();
	});
}

test("WhatsAppClient aborta envio pendurado no timeout como incerto", async (t) => {
	const fetchCalls = installHangingFetch(t);
	const client = new WhatsAppClient({ sendTimeoutMs: 50 });

	await assert.rejects(
		Promise.race([
			client.sendTextMessage("5511999999999", "Olá"),
			failAfter(2000),
		]),
		(error: unknown) => {
			assert.ok(error instanceof WhatsAppSendError, String(error));
			assert.equal(error.kind, "uncertain");
			assert.equal(error.retryable, false);
			return true;
		}
	);
	assert.equal(fetchCalls(), 1);
});

test("WhatsAppClient aborta Reply Buttons pendurado no timeout como incerto", async (t) => {
	installHangingFetch(t);
	const client = new WhatsAppClient({ sendTimeoutMs: 50 });

	await assert.rejects(
		Promise.race([
			client.sendReplyButtonsMessage("5511999999999", "Escolha", [
				{ id: "schedule:slot:1", title: "25/09 às 14:00" },
			]),
			failAfter(2000),
		]),
		(error: unknown) =>
			error instanceof WhatsAppSendError && error.kind === "uncertain"
	);
});

test("WhatsAppClient passa um AbortSignal para o fetch", async (t) => {
	const originalFetch = globalThis.fetch;
	let signal: AbortSignal | null | undefined;
	globalThis.fetch = (async (_url: string | URL, options?: RequestInit) => {
		signal = options?.signal;
		return new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), {
			status: 200,
		});
	}) as typeof fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	await new WhatsAppClient({ sendTimeoutMs: 1000 }).sendTextMessage(
		"5511999999999",
		"Olá"
	);
	assert.ok(signal instanceof AbortSignal);
});

test("WhatsAppClient não loga o telefone do destinatário em erro HTTP", async (t) => {
	const phone = "5511987654321";
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ error: { code: 131_026 } }), {
			status: 400,
			statusText: "Bad Request",
		})) as typeof fetch;
	const logged: string[] = [];
	t.mock.method(console, "error", (...args: unknown[]) => {
		logged.push(JSON.stringify(args));
	});
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	await assert.rejects(
		new WhatsAppClient().sendTextMessage(phone, "Olá"),
		WhatsAppSendError
	);
	assert.ok(logged.length > 0, "expected the HTTP error to be logged");
	assert.ok(!logged.join("").includes(phone), "recipient phone leaked to logs");
});

// Status de erro chega, mas o corpo nunca termina: a Meta já respondeu, então
// o envio é classificado pelo status HTTP, não como incerto.
function installStalledBodyFetch(
	t: { after: (fn: () => void) => void },
	status: number
) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			new ReadableStream({
				start() {
					// Nunca enfileira nem fecha: corpo travado.
				},
			}),
			{
				status,
			}
		)) as typeof fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
}

for (const { status, kind } of [
	{ kind: "permanent", status: 400 },
	{ kind: "retryable", status: 503 },
]) {
	test(`WhatsAppClient classifica HTTP ${status} pelo status mesmo com corpo travado`, async (t) => {
		installStalledBodyFetch(t, status);
		t.mock.method(console, "error", () => undefined);

		await assert.rejects(
			Promise.race([
				new WhatsAppClient({ sendTimeoutMs: 1000 }).sendTextMessage(
					"5511999999999",
					"Olá"
				),
				failAfter(3000),
			]),
			(error: unknown) => {
				assert.ok(error instanceof WhatsAppSendError, String(error));
				assert.equal(error.kind, kind);
				assert.equal(error.httpStatus, status);
				return true;
			}
		);
	});
}
