import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";
import fastify from "fastify";

import { closeDatabase, db } from "../../db/connections";
import { leads } from "../../db/schema";
import { env } from "../../env";
import { googleAdsWebhookRoutes } from "../../routes/google-ads/webhook-google-ads";

test.after(async () => {
	await closeDatabase();
});

function buildApp() {
	const app = fastify();

	app.register(googleAdsWebhookRoutes);

	return app;
}

function createPayload({
	googleKey = env.GOOGLE_ADS_WEBHOOK_KEY,
	isTest = false,
	leadId = `google-test-${Date.now()}`,
	phone = `552499${Date.now().toString().slice(-8)}`,
}: {
	googleKey?: string;
	isTest?: boolean;
	leadId?: string;
	phone?: string;
} = {}) {
	return {
		adgroup_id: 789_012,
		api_version: "1.0",
		campaign_id: 123_456,
		creative_id: 345_678,
		form_id: 123_456_789,
		gcl_id: "test-gclid-001",
		google_key: googleKey,
		is_test: isTest,
		lead_id: leadId,
		user_column_data: [
			{
				column_id: "FULL_NAME",
				column_name: "Full Name",
				string_value: "Cliente Teste Google Ads",
			},
			{
				column_id: "PHONE_NUMBER",
				column_name: "User Phone",
				string_value: phone,
			},
			{
				column_id: "EMAIL",
				column_name: "User Email",
				string_value: "teste-google@example.com",
			},
		],
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

test("POST /webhooks/google-ads - rejeita lead sem telefone", async (t) => {
	const app = buildApp();
	t.after(() => app.close());

	const payload = createPayload({
		isTest: true,
	});

	payload.user_column_data = payload.user_column_data.filter(
		(column) => column.column_id !== "PHONE_NUMBER"
	);

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
