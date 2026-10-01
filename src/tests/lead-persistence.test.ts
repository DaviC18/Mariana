import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";

import { closeDatabase, db } from "../db/connections";
import { leads } from "../db/schema/leads";

test.after(async () => {
	await closeDatabase();
});

function uniquePhone() {
	return `55119${Math.floor(10_000_000 + Math.random() * 90_000_000)}`;
}

test("cria lead incompleto com source padrão whatsapp", async () => {
	const phone = uniquePhone();

	const [lead] = await db
		.insert(leads)
		.values({
			name: "Lead incompleto",
			phone,
		})
		.returning();

	try {
		assert.ok(lead);
		assert.equal(lead.source, "whatsapp");
		assert.equal(lead.objective, null);
		assert.equal(lead.consortiumType, null);
		assert.equal(lead.sourceLeadId, null);
	} finally {
		await db.delete(leads).where(eq(leads.id, lead.id));
	}
});

test("cria lead de google_ads com dados de atribuição", async () => {
	const phone = uniquePhone();

	const [lead] = await db
		.insert(leads)
		.values({
			adGroupId: "google-ad-group-001",
			campaignId: "google-campaign-001",
			email: "google-lead@example.com",
			gclid: "gclid-test-001",
			name: "Lead Google",
			phone,
			source: "google_ads",
			sourceLeadId: "google-lead-001",
		})
		.returning();

	try {
		assert.ok(lead);
		assert.equal(lead.source, "google_ads");
		assert.equal(lead.sourceLeadId, "google-lead-001");
		assert.equal(lead.gclid, "gclid-test-001");
		assert.equal(lead.campaignId, "google-campaign-001");
		assert.equal(lead.adGroupId, "google-ad-group-001");
		assert.equal(lead.email, "google-lead@example.com");
	} finally {
		await db.delete(leads).where(eq(leads.id, lead.id));
	}
});

test("cria lead de meta_ads com dados de campanha", async () => {
	const phone = uniquePhone();

	const [lead] = await db
		.insert(leads)
		.values({
			adId: "meta-ad-001",
			adSetId: "meta-ad-set-001",
			campaignId: "meta-campaign-001",
			name: "Lead Meta",
			phone,
			source: "meta_ads",
			sourceLeadId: "meta-lead-001",
		})
		.returning();

	try {
		assert.ok(lead);
		assert.equal(lead.source, "meta_ads");
		assert.equal(lead.sourceLeadId, "meta-lead-001");
		assert.equal(lead.campaignId, "meta-campaign-001");
		assert.equal(lead.adSetId, "meta-ad-set-001");
		assert.equal(lead.adId, "meta-ad-001");
	} finally {
		await db.delete(leads).where(eq(leads.id, lead.id));
	}
});

test("não permite duplicar o mesmo source e sourceLeadId", async () => {
	const sourceLeadId = `google-duplicate-${Date.now()}`;
	const firstPhone = uniquePhone();
	const secondPhone = uniquePhone();

	const [firstLead] = await db
		.insert(leads)
		.values({
			name: "Primeiro Lead Google",
			phone: firstPhone,
			source: "google_ads",
			sourceLeadId,
		})
		.returning();

	try {
		await assert.rejects(
			db.insert(leads).values({
				name: "Segundo Lead Google",
				phone: secondPhone,
				source: "google_ads",
				sourceLeadId,
			})
		);
	} finally {
		await db.delete(leads).where(eq(leads.id, firstLead.id));
	}
});

test("permite o mesmo sourceLeadId em fontes diferentes", async () => {
	const sourceLeadId = `shared-${Date.now()}`;

	const [googleLead] = await db
		.insert(leads)
		.values({
			name: "Lead Google",
			phone: uniquePhone(),
			source: "google_ads",
			sourceLeadId,
		})
		.returning();

	const [metaLead] = await db
		.insert(leads)
		.values({
			name: "Lead Meta",
			phone: uniquePhone(),
			source: "meta_ads",
			sourceLeadId,
		})
		.returning();

	try {
		assert.ok(googleLead);
		assert.ok(metaLead);
		assert.equal(googleLead.source, "google_ads");
		assert.equal(metaLead.source, "meta_ads");
		assert.equal(googleLead.sourceLeadId, metaLead.sourceLeadId);
	} finally {
		await db.delete(leads).where(eq(leads.id, googleLead.id));
		await db.delete(leads).where(eq(leads.id, metaLead.id));
	}
});
