/** biome-ignore-all lint/suspicious/useAwait: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";
import fastify from "fastify";

import { closeDatabase, db } from "../../db/connections";
import { leads } from "../../db/schema";
import { env } from "../../env";
import { googleAdsWebhookRoutes } from "../../routes/google-ads/webhook-google-ads";
import { leadIngestionService } from "../../services/leads/lead-ingestion";

test.after(async () => {
	await closeDatabase();
});

function buildApp() {
	const app = fastify();

	app.register(googleAdsWebhookRoutes);

	return app;
}

function createPayload({
	adgroupId = 789_012,
	apiVersion = "1.0",
	campaignId = 123_456,
	creativeId = 345_678,
	formId = 123_456_789,
	gclId = "test-gclid-001",
	googleKey = env.GOOGLE_ADS_WEBHOOK_KEY,
	isTest = false,
	leadId = `google-test-${Date.now()}`,
	phone = `552499${Date.now().toString().slice(-8)}`,
	name = "Cliente Teste Google Ads",
	email = "teste-google@example.com",
	includeEmail = true,
	includePhone = true,
	includeName = true,
}: {
	adgroupId?: number;
	apiVersion?: string;
	campaignId?: number;
	creativeId?: number;
	formId?: number;
	gclId?: string;
	googleKey?: string;
	isTest?: boolean;
	leadId?: string;
	phone?: string;
	name?: string;
	email?: string;
	includeEmail?: boolean;
	includePhone?: boolean;
	includeName?: boolean;
} = {}) {
	const userColumnData: Array<{ column_id: string; string_value?: string }> =
		[];

	if (includeName) {
		userColumnData.push({
			column_id: "FULL_NAME",
			string_value: name,
		});
	}

	if (includePhone) {
		userColumnData.push({
			column_id: "PHONE_NUMBER",
			string_value: phone,
		});
	}

	if (includeEmail) {
		userColumnData.push({
			column_id: "EMAIL",
			string_value: email,
		});
	}

	return {
		adgroup_id: adgroupId,
		api_version: apiVersion,
		campaign_id: campaignId,
		creative_id: creativeId,
		form_id: formId,
		gcl_id: gclId,
		google_key: googleKey,
		is_test: isTest,
		lead_id: leadId,
		user_column_data: userColumnData,
	};
}

test("POST /webhooks/google-ads - lead de teste retorna 200 e não persiste", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const leadId = `google-test-${Date.now()}`;

	const payload = createPayload({
		isTest: true,
		leadId,
	});

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload,
		url: "/webhooks/google-ads",
	});

	assert.equal(response.statusCode, 200);
	assert.deepEqual(response.json(), {
		status: "ok",
		test: true,
	});

	const [lead] = await db
		.select()
		.from(leads)
		.where(eq(leads.sourceLeadId, leadId))
		.limit(1);

	assert.equal(lead, undefined);
});

test("POST /webhooks/google-ads - rejeita google_key inválida", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payload = createPayload({
		googleKey: "invalid-google-key",
		isTest: true,
	});

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload,
		url: "/webhooks/google-ads",
	});

	assert.equal(response.statusCode, 401);
	assert.deepEqual(response.json(), {
		error: "Unauthorized",
	});
});

test("POST /webhooks/google-ads - rejeita google_key ausente", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payload = createPayload({
		isTest: true,
	});
	// Remove google_key
	const { google_key: _, ...payloadWithoutKey } = payload;

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload: payloadWithoutKey,
		url: "/webhooks/google-ads",
	});

	assert.equal(response.statusCode, 400);
	assert.deepEqual(response.json(), {
		error: "Invalid payload",
	});
});

test("POST /webhooks/google-ads - rejeita lead_id ausente", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payload = createPayload({
		isTest: true,
	});
	// Remove lead_id
	const { lead_id: _, ...payloadWithoutLeadId } = payload;

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload: payloadWithoutLeadId,
		url: "/webhooks/google-ads",
	});

	assert.equal(response.statusCode, 400);
	assert.deepEqual(response.json(), {
		error: "Invalid payload",
	});
});

test("POST /webhooks/google-ads - rejeita payload inválido", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload: {
			google_key: env.GOOGLE_ADS_WEBHOOK_KEY,
			is_test: true,
			user_column_data: [],
		},
		url: "/webhooks/google-ads",
	});

	assert.equal(response.statusCode, 400);
	assert.deepEqual(response.json(), {
		error: "Invalid payload",
	});
});

test("POST /webhooks/google-ads - rejeita payload vazio ({})", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload: {},
		url: "/webhooks/google-ads",
	});

	assert.equal(response.statusCode, 400);
	assert.deepEqual(response.json(), {
		error: "Invalid payload",
	});
});

test("POST /webhooks/google-ads - rejeita lead sem telefone", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payload = createPayload({
		includePhone: false,
		isTest: true,
	});

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload,
		url: "/webhooks/google-ads",
	});

	assert.equal(response.statusCode, 400);
	assert.deepEqual(response.json(), {
		error: "PHONE_NUMBER is required",
	});
});

test("POST /webhooks/google-ads - cria lead com dados de atribuição", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const leadId = `google-production-test-${Date.now()}`;
	const phone = `552499${Date.now().toString().slice(-8)}`;

	const payload = createPayload({
		leadId,
		phone,
	});

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload,
		url: "/webhooks/google-ads",
	});

	assert.equal(response.statusCode, 200);

	const body = response.json();

	assert.equal(body.status, "ok");
	assert.equal(body.created, true);
	assert.equal(typeof body.leadId, "string");

	const [lead] = await db
		.select()
		.from(leads)
		.where(eq(leads.id, body.leadId))
		.limit(1);

	assert.ok(lead);

	assert.equal(lead.name, "Cliente Teste Google Ads");
	assert.equal(lead.phone, phone);
	assert.equal(lead.email, "teste-google@example.com");
	assert.equal(lead.source, "google_ads");
	assert.equal(lead.sourceLeadId, leadId);
	assert.equal(lead.gclid, "test-gclid-001");
	assert.equal(lead.campaignId, "123456");
	assert.equal(lead.adGroupId, "789012");
	assert.equal(lead.adId, "345678");

	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("POST /webhooks/google-ads - mesmo lead_id não duplica o lead", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const leadId = `google-idempotency-test-${Date.now()}`;
	const phone = `552499${Date.now().toString().slice(-8)}`;

	const payload = createPayload({
		leadId,
		phone,
	});

	const firstResponse = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload,
		url: "/webhooks/google-ads",
	});

	assert.equal(firstResponse.statusCode, 200);

	const firstBody = firstResponse.json();

	assert.equal(firstBody.created, true);

	const secondResponse = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload,
		url: "/webhooks/google-ads",
	});

	assert.equal(secondResponse.statusCode, 200);

	const secondBody = secondResponse.json();

	assert.equal(secondBody.created, false);
	assert.equal(secondBody.leadId, firstBody.leadId);

	const allLeads = await db
		.select()
		.from(leads)
		.where(eq(leads.sourceLeadId, leadId));

	assert.equal(allLeads.length, 1);

	await db.delete(leads).where(eq(leads.id, firstBody.leadId));
});

test("POST /webhooks/google-ads - aceita payload sem email e cria lead", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const leadId = `google-no-email-test-${Date.now()}`;
	const phone = `552499${Date.now().toString().slice(-8)}`;

	const payload = createPayload({
		includeEmail: false,
		leadId,
		phone,
	});

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload,
		url: "/webhooks/google-ads",
	});

	assert.equal(response.statusCode, 200);
	const body = response.json();
	assert.equal(body.status, "ok");
	assert.equal(body.created, true);

	const [lead] = await db
		.select()
		.from(leads)
		.where(eq(leads.id, body.leadId))
		.limit(1);

	assert.ok(lead);
	assert.equal(lead.email, null);
	assert.equal(lead.phone, phone);

	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("POST /webhooks/google-ads - aceita telefone com máscara e formatação", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const leadId = `google-phone-mask-test-${Date.now()}`;
	const randomSuffix = Date.now().toString().slice(-4);
	const maskedPhone = `+55 (24) 9988-${randomSuffix}`;
	const expectedNormalizedPhone = `55249988${randomSuffix}`;

	const payload = createPayload({
		leadId,
		phone: maskedPhone,
	});

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload,
		url: "/webhooks/google-ads",
	});

	assert.equal(response.statusCode, 200);
	const body = response.json();
	assert.equal(body.status, "ok");

	const [lead] = await db
		.select()
		.from(leads)
		.where(eq(leads.id, body.leadId))
		.limit(1);

	assert.ok(lead);
	assert.equal(lead.phone, expectedNormalizedPhone);

	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("POST /webhooks/google-ads - tolera campos desconhecidos e colunas desconhecidas", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const leadId = `google-unknown-fields-${Date.now()}`;
	const phone = `552499${Date.now().toString().slice(-8)}`;

	const payload = {
		...createPayload({ leadId, phone }),
		future_google_ads_field: "unexpected_value",
		nested_object_unknown: { foo: "bar" },
	};

	payload.user_column_data.push({
		column_id: "CUSTOM_FIELD_WHATEVER",
		string_value: "Custom value from form",
	});

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload,
		url: "/webhooks/google-ads",
	});

	assert.equal(response.statusCode, 200);
	const body = response.json();
	assert.equal(body.status, "ok");
	assert.equal(body.created, true);

	const [lead] = await db
		.select()
		.from(leads)
		.where(eq(leads.id, body.leadId))
		.limit(1);

	assert.ok(lead);

	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("POST /webhooks/google-ads - aceita campos opcionais de atribuição ausentes", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const leadId = `google-min-attrib-${Date.now()}`;
	const phone = `552499${Date.now().toString().slice(-8)}`;

	const payload = {
		google_key: env.GOOGLE_ADS_WEBHOOK_KEY,
		lead_id: leadId,
		user_column_data: [
			{
				column_id: "PHONE_NUMBER",
				string_value: phone,
			},
		],
	};

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload,
		url: "/webhooks/google-ads",
	});

	assert.equal(response.statusCode, 200);
	const body = response.json();
	assert.equal(body.status, "ok");
	assert.equal(body.created, true);

	const [lead] = await db
		.select()
		.from(leads)
		.where(eq(leads.id, body.leadId))
		.limit(1);

	assert.ok(lead);
	assert.equal(lead.phone, phone);
	assert.equal(lead.campaignId, null);
	assert.equal(lead.adGroupId, null);
	assert.equal(lead.gclid, null);
	assert.equal(lead.adId, null);

	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("POST /webhooks/google-ads - rejeita tipos inválidos para campaign_id e adgroup_id", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payload = {
		...createPayload(),
		adgroup_id: "not-a-number",
		campaign_id: "not-a-number",
	};

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload,
		url: "/webhooks/google-ads",
	});

	assert.equal(response.statusCode, 400);
	assert.deepEqual(response.json(), {
		error: "Invalid payload",
	});
});

test("POST /webhooks/google-ads - delega persistência exclusivamente ao LeadIngestionService", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const originalIngest = leadIngestionService.ingest;
	let ingestCalled = false;
	let capturedInput:
		| Parameters<typeof leadIngestionService.ingest>[0]
		| undefined;

	leadIngestionService.ingest = async (input) => {
		ingestCalled = true;
		capturedInput = input;
		return {
			created: true,
			lead: {
				id: "mocked-lead-id-12345",
			} as unknown as typeof leads.$inferSelect,
		};
	};

	t.after(() => {
		leadIngestionService.ingest = originalIngest;
	});

	const leadId = `google-delegation-test-${Date.now()}`;
	const phone = `552499${Date.now().toString().slice(-8)}`;

	const payload = createPayload({
		leadId,
		phone,
	});

	const response = await app.inject({
		headers: {
			"content-type": "application/json",
		},
		method: "POST",
		payload,
		url: "/webhooks/google-ads",
	});

	assert.equal(response.statusCode, 200);
	assert.equal(ingestCalled, true);
	assert.ok(capturedInput);
	assert.equal(capturedInput.source, "google_ads");
	assert.equal(capturedInput.sourceLeadId, leadId);
	assert.equal(capturedInput.phone, phone);
	assert.deepEqual(response.json(), {
		created: true,
		leadId: "mocked-lead-id-12345",
		status: "ok",
	});
});
