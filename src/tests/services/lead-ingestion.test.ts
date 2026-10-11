import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";

import { closeDatabase, db } from "../../db/connections";
import { leads } from "../../db/schema";
import { LeadIngestionService } from "../../services/leads/lead-ingestion";

const service = new LeadIngestionService();

test.after(async () => {
	await closeDatabase();
});

function uniquePhone() {
	return `55119${Math.floor(10_000_000 + Math.random() * 90_000_000)}`;
}

test("cria lead incompleto vindo do WhatsApp", async () => {
	const phone = uniquePhone();

	const result = await service.ingest({
		phone,
		// source: whatsapp
		source: "whatsapp",
	});

	try {
		assert.equal(result.created, true);
		assert.equal(result.lead.source, "whatsapp");
		assert.equal(result.lead.phone, phone);
		assert.equal(result.lead.objective, null);
		assert.equal(result.lead.consortiumType, null);
		assert.equal(result.lead.sourceLeadId, null);
	} finally {
		await db.delete(leads).where(eq(leads.id, result.lead.id));
	}
});

test("cria lead do Google Ads com atribuição", async () => {
	const phone = uniquePhone();

	const result = await service.ingest({
		adGroupId: "ad-group-google",
		campaignId: "campaign-google",
		email: "lead@google.test",
		gclid: "gclid-test",
		name: "Lead Google",
		phone,
		source: "google_ads",
		sourceLeadId: `google-${Date.now()}`,
	});

	try {
		assert.equal(result.created, true);
		assert.equal(result.lead.source, "google_ads");
		assert.equal(result.lead.email, "lead@google.test");
		assert.equal(result.lead.gclid, "gclid-test");
		assert.equal(result.lead.campaignId, "campaign-google");
		assert.equal(result.lead.adGroupId, "ad-group-google");
	} finally {
		await db.delete(leads).where(eq(leads.id, result.lead.id));
	}
});

test("cria lead do Meta Ads com atribuição", async () => {
	const phone = uniquePhone();

	const result = await service.ingest({
		adId: "ad-meta",
		adSetId: "ad-set-meta",
		campaignId: "campaign-meta",
		name: "Lead Meta",
		phone,
		source: "meta_ads",
		sourceLeadId: `meta-${Date.now()}`,
	});

	try {
		assert.equal(result.created, true);
		assert.equal(result.lead.source, "meta_ads");
		assert.equal(result.lead.campaignId, "campaign-meta");
		assert.equal(result.lead.adSetId, "ad-set-meta");
		assert.equal(result.lead.adId, "ad-meta");
	} finally {
		await db.delete(leads).where(eq(leads.id, result.lead.id));
	}
});

test("reutiliza o mesmo lead quando WhatsApp chega depois do Google Ads", async () => {
	const phone = uniquePhone();
	const sourceLeadId = `google-${Date.now()}`;

	const googleResult = await service.ingest({
		email: "lead@google.test",
		gclid: "gclid-test",
		name: "Lead Google",
		phone,
		source: "google_ads",
		sourceLeadId,
	});

	const whatsappResult = await service.ingest({
		name: "Lead WhatsApp",
		phone: `+${phone.slice(0, 2)} ${phone.slice(2)}`,
		source: "whatsapp",
	});

	try {
		assert.equal(googleResult.lead.id, whatsappResult.lead.id);
		assert.equal(whatsappResult.created, false);
		assert.equal(whatsappResult.lead.source, "google_ads");
		assert.equal(whatsappResult.lead.sourceLeadId, sourceLeadId);
		assert.equal(whatsappResult.lead.gclid, "gclid-test");
	} finally {
		await db.delete(leads).where(eq(leads.id, googleResult.lead.id));
	}
});

test("lead WhatsApp é promovido para origem de Ads quando o Ads chega depois", async () => {
	const phone = uniquePhone();

	const whatsappResult = await service.ingest({
		name: "Lead inicial",
		phone,
		source: "whatsapp",
	});

	const googleResult = await service.ingest({
		campaignId: "campaign-upgrade",
		gclid: "gclid-upgrade",
		name: "Lead Google",
		phone,
		source: "google_ads",
		sourceLeadId: `google-${Date.now()}`,
	});

	try {
		assert.equal(googleResult.created, false);
		assert.equal(googleResult.lead.id, whatsappResult.lead.id);
		assert.equal(googleResult.lead.source, "google_ads");
		assert.equal(googleResult.lead.gclid, "gclid-upgrade");
		assert.equal(googleResult.lead.campaignId, "campaign-upgrade");
	} finally {
		await db.delete(leads).where(eq(leads.id, whatsappResult.lead.id));
	}
});

test("não duplica o mesmo lead externo", async () => {
	const phone = uniquePhone();
	const sourceLeadId = `google-duplicate-${Date.now()}`;

	const first = await service.ingest({
		name: "Lead Google",
		phone,
		source: "google_ads",
		sourceLeadId,
	});

	const second = await service.ingest({
		name: "Lead Google Atualizado",
		phone: uniquePhone(),
		source: "google_ads",
		sourceLeadId,
	});

	try {
		assert.equal(first.created, true);
		assert.equal(second.created, false);
		assert.equal(first.lead.id, second.lead.id);
		assert.equal(second.lead.name, "Lead Google Atualizado");
	} finally {
		await db.delete(leads).where(eq(leads.id, first.lead.id));
	}
});
