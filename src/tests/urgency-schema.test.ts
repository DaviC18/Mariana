import assert from "node:assert/strict";
import test from "node:test";
import { eq, sql } from "drizzle-orm";

import { marianaResponseSchema } from "../ai/schemas/mariana-response-schema";
import { closeDatabase, db } from "../db/connections";
import { leads, leadUrgency } from "../db/schema/leads";
import { updateLeadFromAgent } from "../services/leads/update-lead-from-agent";

const EXPECTED_URGENCIES = [
	"immediate",
	"short_term",
	"medium_term",
	"long_term",
] as const;

function uniquePhone() {
	return `55119${Math.floor(10_000_000 + Math.random() * 90_000_000)}`;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
	if (Array.isArray(result)) {
		return result as Record<string, unknown>[];
	}

	const maybeRows = (result as { rows?: Record<string, unknown>[] }).rows;
	return maybeRows ?? [];
}

test.after(async () => {
	await closeDatabase();
});

test("o enum lead_urgency expõe exatamente os valores aceitos", () => {
	assert.deepEqual([...leadUrgency.enumValues], [...EXPECTED_URGENCIES]);
});

test("o contrato da IA aceita todos os valores válidos de urgency", () => {
	for (const urgency of EXPECTED_URGENCIES) {
		const parsed = marianaResponseSchema.parse({
			leadUpdate: { status: "qualifying", urgency },
			reply: "Ok.",
		});

		assert.equal(parsed.leadUpdate.urgency, urgency);
	}
});

test("o contrato da IA rejeita valores inválidos de urgency", () => {
	assert.throws(() =>
		marianaResponseSchema.parse({
			leadUpdate: { status: "qualifying", urgency: "eventually" },
			reply: "Ok.",
		})
	);
});

test("updateLeadFromAgent propaga urgency válida para a persistência", async () => {
	let persistedUrgency: string | undefined;

	await updateLeadFromAgent({
		appointmentCreated: false,
		currentStatus: "qualifying",
		interestedInConsultant: true,
		leadId: "lead-urgency-valid",
		leadUpdate: {
			consortiumType: "Veículo",
			currentSituation: "Uso carro antigo",
			objective: "Comprar um carro",
			painPoint: "Quero reduzir custos",
			status: "qualified",
			urgency: "short_term",
		},
		persistLead: ({ values }) => {
			persistedUrgency = values.urgency;
			return Promise.resolve({ id: "lead-urgency-valid" });
		},
	});

	assert.equal(persistedUrgency, "short_term");
});

test("persiste e relê urgency na tabela leads", async () => {
	const phone = uniquePhone();

	const [lead] = await db
		.insert(leads)
		.values({
			name: "Lead com urgência",
			phone,
			urgency: "medium_term",
		})
		.returning();

	try {
		assert.equal(lead.urgency, "medium_term");

		const [reloaded] = await db
			.select()
			.from(leads)
			.where(eq(leads.id, lead.id))
			.limit(1);

		assert.equal(reloaded.urgency, "medium_term");
	} finally {
		await db.delete(leads).where(eq(leads.id, lead.id));
	}
});

test("o schema criado pelas migrations contém a coluna urgency e as tabelas/índices esperados", async () => {
	const urgencyColumn = rowsOf(
		await db.execute(
			sql`select udt_name as "udtName" from information_schema.columns where table_schema = 'public' and table_name = 'leads' and column_name = 'urgency'`
		)
	);
	assert.equal(urgencyColumn.length, 1, "leads.urgency deve existir");
	assert.equal(urgencyColumn[0].udtName, "lead_urgency");

	const webhookColumns = rowsOf(
		await db.execute(
			sql`select column_name as "columnName" from information_schema.columns where table_schema = 'public' and table_name = 'whatsapp_webhook_events' and column_name in ('lastError', 'leaseExpiresAt')`
		)
	).map((row) => row.columnName);
	assert.deepEqual(
		webhookColumns.sort(),
		["lastError", "leaseExpiresAt"],
		"whatsapp_webhook_events deve ter as colunas de lease/erro"
	);

	const webhookIndexes = rowsOf(
		await db.execute(
			sql`select indexname from pg_indexes where schemaname = 'public' and tablename = 'whatsapp_webhook_events'`
		)
	).map((row) => row.indexname as string);
	assert.ok(
		webhookIndexes.includes(
			"whatsapp_webhook_events_status_lease_expires_at_idx"
		),
		"o índice de lease deve existir"
	);

	const messageUniqueIndexes = rowsOf(
		await db.execute(
			sql`select indexname from pg_indexes where schemaname = 'public' and tablename = 'messages' and indexname = 'messages_external_id_unique_idx'`
		)
	);
	assert.equal(
		messageUniqueIndexes.length,
		1,
		"o índice único parcial em messages.externalId deve existir"
	);
});
