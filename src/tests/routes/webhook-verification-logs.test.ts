/**
 * A verificação GET dos webhooks recebe o verify token na query string. Ele
 * não pode aparecer em nenhuma linha de log: nem no log do handler, nem no
 * `req.url` do log automático de requisição do Fastify.
 */
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import fastify from "fastify";
import {
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { env } from "../../env";
import { baseLoggerOptions, redactSensitiveQuery } from "../../lib/logger";
import { metaAdsWebhookRoutes } from "../../routes/meta-ads/webhook-meta-ads";
import { webhookWhatsApp } from "../../routes/whatsapp/webhook-whatsapp";

const WRONG_TOKEN = "wrong-verify-token-leak-check-9431";

function buildAppWithCapturedLogs() {
	const lines: string[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			lines.push(chunk.toString());
			callback();
		},
	});
	const app = fastify({
		logger: { ...baseLoggerOptions, stream },
	}).withTypeProvider<ZodTypeProvider>();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	app.register(webhookWhatsApp);
	app.register(metaAdsWebhookRoutes);
	return { app, logs: () => lines.join("") };
}

for (const { path, validToken } of [
	{ path: "/webhooks/whatsapp", validToken: env.WHATSAPP_VERIFY_TOKEN },
	{ path: "/webhooks/meta-ads", validToken: env.META_ADS_VERIFY_TOKEN },
]) {
	test(`GET ${path} nunca loga o verify token`, async (t) => {
		const { app, logs } = buildAppWithCapturedLogs();
		t.after(() => app.close());

		const rejected = await app.inject({
			method: "GET",
			url: `${path}?hub.mode=subscribe&hub.verify_token=${WRONG_TOKEN}&hub.challenge=C1`,
		});
		assert.equal(rejected.statusCode, 403);

		const accepted = await app.inject({
			method: "GET",
			url: `${path}?hub.mode=subscribe&hub.verify_token=${validToken}&hub.challenge=C2`,
		});
		assert.equal(accepted.statusCode, 200);

		const output = logs();
		assert.ok(output.length > 0, "expected request logs to be captured");
		assert.ok(!output.includes(WRONG_TOKEN), "wrong token leaked to logs");
		assert.ok(!output.includes(validToken), "valid token leaked to logs");
	});
}

test("GET /webhooks/whatsapp loga só se o token conferiu", async (t) => {
	const { app, logs } = buildAppWithCapturedLogs();
	t.after(() => app.close());

	await app.inject({
		method: "GET",
		url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${WRONG_TOKEN}&hub.challenge=C1`,
	});

	const failure = logs()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.find((entry) => entry.event === "whatsapp_webhook_verification_failed");
	assert.ok(failure);
	assert.equal(failure.tokenMatched, false);
	assert.equal(Object.hasOwn(failure, "token"), false);
});

test("redactSensitiveQuery mascara tokens, segredos e chaves na query", () => {
	assert.equal(
		redactSensitiveQuery(
			"/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=123"
		),
		"/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=%5BRedacted%5D&hub.challenge=123"
	);
	assert.equal(
		redactSensitiveQuery("/x?access_token=a&api_key=b&client_secret=c&code=d"),
		"/x?access_token=%5BRedacted%5D&api_key=%5BRedacted%5D&client_secret=%5BRedacted%5D&code=%5BRedacted%5D"
	);
	assert.equal(redactSensitiveQuery("/leads?page=2"), "/leads?page=2");
	assert.equal(redactSensitiveQuery("/health"), "/health");
});

test("rota inexistente não loga o verify token no aviso de 404", async (t) => {
	const { app, logs } = buildAppWithCapturedLogs();
	t.after(() => app.close());

	const response = await app.inject({
		method: "GET",
		url: `/webhooks/whatsap?hub.verify_token=${WRONG_TOKEN}`,
	});
	assert.equal(response.statusCode, 404);
	assert.ok(logs().includes("not found"), "expected the 404 log line");
	assert.ok(!logs().includes(WRONG_TOKEN), "token leaked in the 404 log");
});

test("redactSensitiveQuery não lança com URLs que new URL rejeita", () => {
	assert.equal(redactSensitiveQuery("//?a=1"), "//?a=1");
	assert.equal(
		redactSensitiveQuery("//[?hub.verify_token=s"),
		"//[?hub.verify_token=%5BRedacted%5D"
	);
	assert.equal(
		redactSensitiveQuery("//evil.example/x?access_token=s&page=2"),
		"//evil.example/x?access_token=%5BRedacted%5D&page=2"
	);
	assert.equal(
		redactSensitiveQuery("Route GET:/x?code=abc&y=1 not found"),
		"Route GET:/x?code=%5BRedacted%5D&y=1 not found"
	);
});
