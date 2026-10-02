import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import fastify from "fastify";
import {
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { closeDatabase } from "../../db/connections";
import { env } from "../../env";
import { metaAdsWebhookRoutes } from "../../routes/meta-ads/webhook-meta-ads";

test.after(async () => {
	await closeDatabase();
});

function buildApp() {
	const app = fastify().withTypeProvider<ZodTypeProvider>();

	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);

	app.register(metaAdsWebhookRoutes);

	return app;
}

function computeMetaSignature(
	rawBody: string,
	secret: string = env.META_ADS_APP_SECRET
): string {
	return (
		"sha256=" +
		crypto.createHmac("sha256", secret).update(rawBody).digest("hex")
	);
}

function createValidLeadgenPayload({
	adId = "ad_12345",
	adgroupId = "adgroup_67890",
	createdTime = 1_780_000_000,
	formId = "form_99999",
	leadgenId = "leadgen_88888",
	pageId = "page_11111",
}: {
	adId?: string;
	adgroupId?: string;
	createdTime?: number;
	formId?: string;
	leadgenId?: string;
	pageId?: string;
} = {}) {
	return {
		entry: [
			{
				changes: [
					{
						field: "leadgen",
						value: {
							ad_id: adId,
							adgroup_id: adgroupId,
							created_time: createdTime,
							form_id: formId,
							leadgen_id: leadgenId,
							page_id: pageId,
						},
					},
				],
				id: pageId,
				time: createdTime,
			},
		],
		object: "page",
	};
}

// 1. GET /webhooks/meta-ads - verify token correto -> 200 + challenge
test("GET /webhooks/meta-ads - verify token correto retorna 200 e challenge", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const response = await app.inject({
		method: "GET",
		url: `/webhooks/meta-ads?hub.mode=subscribe&hub.verify_token=${env.META_ADS_VERIFY_TOKEN}&hub.challenge=CHALLENGE_META_123`,
	});

	assert.equal(response.statusCode, 200);
	assert.equal(response.body, "CHALLENGE_META_123");
});

// 2. GET /webhooks/meta-ads - verify token incorreto -> 403
test("GET /webhooks/meta-ads - verify token incorreto retorna HTTP 403 Forbidden", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const response = await app.inject({
		method: "GET",
		url: "/webhooks/meta-ads?hub.mode=subscribe&hub.verify_token=WRONG_META_TOKEN&hub.challenge=CHALLENGE_META_123",
	});

	assert.equal(response.statusCode, 403);
	assert.deepEqual(response.json(), {
		error: "Forbidden",
	});
});

// 3. POST /webhooks/meta-ads - assinatura ausente -> 401
test("POST /webhooks/meta-ads - sem X-Hub-Signature-256 retorna 401", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payloadStr = JSON.stringify(createValidLeadgenPayload());

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload: payloadStr,
		url: "/webhooks/meta-ads",
	});

	assert.equal(response.statusCode, 401);
	assert.deepEqual(response.json(), {
		error: "Invalid signature",
	});
});

// 4. POST /webhooks/meta-ads - assinatura sem "sha256=" -> 401
test("POST /webhooks/meta-ads - assinatura sem prefixo sha256= retorna 401", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payloadStr = JSON.stringify(createValidLeadgenPayload());
	const rawHash = crypto
		.createHmac("sha256", env.META_ADS_APP_SECRET)
		.update(payloadStr)
		.digest("hex");

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": rawHash,
		},
		method: "POST",
		payload: payloadStr,
		url: "/webhooks/meta-ads",
	});

	assert.equal(response.statusCode, 401);
	assert.deepEqual(response.json(), {
		error: "Invalid signature",
	});
});

// 5. POST /webhooks/meta-ads - assinatura inválida -> 401
test("POST /webhooks/meta-ads - assinatura HMAC com secret errado retorna 401", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payloadStr = JSON.stringify(createValidLeadgenPayload());
	const wrongSignature = computeMetaSignature(
		payloadStr,
		"wrong_secret_key_123"
	);

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": wrongSignature,
		},
		method: "POST",
		payload: payloadStr,
		url: "/webhooks/meta-ads",
	});

	assert.equal(response.statusCode, 401);
	assert.deepEqual(response.json(), {
		error: "Invalid signature",
	});
});

// 6. POST /webhooks/meta-ads - assinatura HMAC correta -> 200
test("POST /webhooks/meta-ads - assinatura HMAC correta retorna 200", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payloadStr = JSON.stringify(createValidLeadgenPayload());
	const validSignature = computeMetaSignature(payloadStr);

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": validSignature,
		},
		method: "POST",
		payload: payloadStr,
		url: "/webhooks/meta-ads",
	});

	assert.equal(response.statusCode, 200);
	assert.deepEqual(response.json(), {
		leadgenEvents: 1,
		status: "ok",
	});
});

// 7. POST /webhooks/meta-ads - payload inválido -> 400
test("POST /webhooks/meta-ads - payload estruturalmente inválido retorna 400", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const invalidPayload = JSON.stringify({
		not_an_entry: 123,
	});
	const signature = computeMetaSignature(invalidPayload);

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": signature,
		},
		method: "POST",
		payload: invalidPayload,
		url: "/webhooks/meta-ads",
	});

	assert.equal(response.statusCode, 400);
	assert.deepEqual(response.json(), {
		error: "Invalid payload",
	});
});

// 8. POST /webhooks/meta-ads - object diferente de "page" -> 200 ignored
test("POST /webhooks/meta-ads - object diferente de page retorna 200 ignored", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payload = {
		entry: [],
		object: "instagram",
	};
	const payloadStr = JSON.stringify(payload);
	const signature = computeMetaSignature(payloadStr);

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": signature,
		},
		method: "POST",
		payload: payloadStr,
		url: "/webhooks/meta-ads",
	});

	assert.equal(response.statusCode, 200);
	assert.deepEqual(response.json(), {
		status: "ignored",
	});
});

// 9. POST /webhooks/meta-ads - payload sem leadgen -> 200 ignored
test("POST /webhooks/meta-ads - change.field diferente de leadgen retorna 200 ignored", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payload = {
		entry: [
			{
				changes: [
					{
						field: "feed",
						value: { item: "status", verb: "add" },
					},
				],
				id: "page_123",
				time: 1_780_000_000,
			},
		],
		object: "page",
	};
	const payloadStr = JSON.stringify(payload);
	const signature = computeMetaSignature(payloadStr);

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": signature,
		},
		method: "POST",
		payload: payloadStr,
		url: "/webhooks/meta-ads",
	});

	assert.equal(response.statusCode, 200);
	assert.deepEqual(response.json(), {
		status: "ignored",
	});
});

// 10. POST /webhooks/meta-ads - evento leadgen válido -> 200 e leadgenEvents = 1
test("POST /webhooks/meta-ads - evento leadgen válido retorna 200 e contabiliza leadgenEvents", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payload = createValidLeadgenPayload({
		adId: "ad_test_456",
		formId: "form_test_789",
		leadgenId: "leadgen_unique_999",
	});
	const payloadStr = JSON.stringify(payload);
	const signature = computeMetaSignature(payloadStr);

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": signature,
		},
		method: "POST",
		payload: payloadStr,
		url: "/webhooks/meta-ads",
	});

	assert.equal(response.statusCode, 200);
	assert.deepEqual(response.json(), {
		leadgenEvents: 1,
		status: "ok",
	});
});

// 11. Teste crítico de integridade do raw body:
// construir uma string JSON específica, calcular HMAC exatamente sobre ela, enviar exatamente essa string
test("POST /webhooks/meta-ads - integridade do raw body: preserva espaçamento e formatação exata", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	// Raw JSON formatted with unusual spaces/newlines
	const rawPayloadString =
		'{\n  "object": "page",\n  "entry": [\n    {\n      "id": "page_custom_spaces",\n      "changes": [\n        {\n          "field": "leadgen",\n          "value": {\n            "leadgen_id": "lg_raw_test_123",\n            "form_id": "f_123"\n          }\n        }\n      ]\n    }\n  ]\n}';

	const exactSignature = computeMetaSignature(rawPayloadString);

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": exactSignature,
		},
		method: "POST",
		payload: rawPayloadString,
		url: "/webhooks/meta-ads",
	});

	assert.equal(response.statusCode, 200);
	assert.deepEqual(response.json(), {
		leadgenEvents: 1,
		status: "ok",
	});
});

// 12. Teste crítico negativo:
// calcular assinatura sobre um body e alterar o body antes do envio -> 401
test("POST /webhooks/meta-ads - body alterado após cálculo da assinatura retorna 401", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const originalBody = JSON.stringify(createValidLeadgenPayload());
	const originalSignature = computeMetaSignature(originalBody);

	const tamperedBody = JSON.stringify({
		...createValidLeadgenPayload(),
		tampered: true,
	});

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": originalSignature,
		},
		method: "POST",
		payload: tamperedBody,
		url: "/webhooks/meta-ads",
	});

	assert.equal(response.statusCode, 401);
	assert.deepEqual(response.json(), {
		error: "Invalid signature",
	});
});

// 13. Teste de assinatura malformada:
// hash com tamanho incorreto, hex inválido -> retorna 401 sem exception
test("POST /webhooks/meta-ads - assinaturas malformadas retornam 401 sem exceção", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payloadStr = JSON.stringify(createValidLeadgenPayload());

	const malformedSignatures = [
		"sha256=",
		"sha256=123",
		"sha256=not_a_hex_value_at_all_1234567890abcdef1234567890abcdef1234567890",
		`sha256=${"a".repeat(63)}`, // 63 chars (should be 64)
		`sha256=${"a".repeat(65)}`, // 65 chars (should be 64)
		`sha256=${"g".repeat(64)}`, // invalid hex characters
		"sha1=abcdef1234567890",
	];

	await Promise.all(
		malformedSignatures.map(async (sig) => {
			const response = await app.inject({
				headers: {
					"content-type": "application/json",
					"x-hub-signature-256": sig,
				},
				method: "POST",
				payload: payloadStr,
				url: "/webhooks/meta-ads",
			});

			assert.equal(
				response.statusCode,
				401,
				`Signature "${sig}" should return 401`
			);
			assert.deepEqual(response.json(), {
				error: "Invalid signature",
			});
		})
	);
});

// 14. POST leadgen com leadgen_id ausente -> 400
test("POST /webhooks/meta-ads - leadgen com leadgen_id ausente retorna 400", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payload = {
		entry: [
			{
				changes: [
					{
						field: "leadgen",
						value: {
							form_id: "form_without_leadgen_id",
						},
					},
				],
				id: "page_123",
			},
		],
		object: "page",
	};
	const payloadStr = JSON.stringify(payload);
	const signature = computeMetaSignature(payloadStr);

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": signature,
		},
		method: "POST",
		payload: payloadStr,
		url: "/webhooks/meta-ads",
	});

	assert.equal(response.statusCode, 400);
	assert.deepEqual(response.json(), {
		error: "Invalid payload",
	});
});

// 15. POST leadgen com campos adicionais desconhecidos -> continua funcionando e retorna 200
test("POST /webhooks/meta-ads - campos adicionais desconhecidos são aceitos e retorna 200", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payload = {
		entry: [
			{
				changes: [
					{
						field: "leadgen",
						unknown_meta_field: "some_future_value",
						value: {
							ad_id: "ad_123",
							custom_field_x: "something",
							form_id: "form_123",
							leadgen_id: "leadgen_extra_fields_ok",
							nested_data: { a: 1 },
							page_id: "page_123",
						},
					},
				],
				extra_entry_field: "extra_val",
				id: "page_123",
			},
		],
		extra_root_field: "root_val",
		object: "page",
	};
	const payloadStr = JSON.stringify(payload);
	const signature = computeMetaSignature(payloadStr);

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
			"x-hub-signature-256": signature,
		},
		method: "POST",
		payload: payloadStr,
		url: "/webhooks/meta-ads",
	});

	assert.equal(response.statusCode, 200);
	assert.deepEqual(response.json(), {
		leadgenEvents: 1,
		status: "ok",
	});
});
