/** biome-ignore-all lint/suspicious/useAwait: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";
import fastify from "fastify";
import {
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { closeDatabase, db } from "../../db/connections";
import { conversations } from "../../db/schema/conversations";
import { leads } from "../../db/schema/leads";
import { createConversations } from "../../routes/conversations/create-conversations";
import { getOrCreateActiveConversation } from "../../services/conversations/active-conversation";

test.after(async () => {
	await closeDatabase();
});

async function createLead() {
	const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const [lead] = await db
		.insert(leads)
		.values({
			name: `Lead Active Conversation ${suffix}`,
			phone: `551197${suffix.slice(-9)}`,
		})
		.returning({ id: leads.id });
	assert.ok(lead);
	return lead.id;
}

async function countActive(leadId: string) {
	const rows = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(
			and(eq(conversations.leadId, leadId), eq(conversations.status, "active"))
		);
	return rows.length;
}

async function cleanup(leadId: string) {
	await db.delete(conversations).where(eq(conversations.leadId, leadId));
	await db.delete(leads).where(eq(leads.id, leadId));
}

function buildApp() {
	const app = fastify().withTypeProvider<ZodTypeProvider>();
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(serializerCompiler);
	app.register(createConversations);
	return app;
}

test("duas criações concorrentes para o mesmo lead produzem uma única conversa ativa", async () => {
	const leadId = await createLead();

	try {
		let signalFirstLocked: () => void = () => undefined;
		const firstLocked = new Promise<void>((resolve) => {
			signalFirstLocked = resolve;
		});
		let releaseFirst: () => void = () => undefined;
		const firstMayProceed = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const firstTransaction = db.transaction(async (tx) => {
			const [lockedLead] = await tx
				.select({ id: leads.id })
				.from(leads)
				.where(eq(leads.id, leadId))
				.for("update");

			assert.ok(lockedLead);
			signalFirstLocked();
			await firstMayProceed;

			return await getOrCreateActiveConversation(tx, leadId);
		});

		await firstLocked;

		const secondTransaction = db.transaction((tx) =>
			getOrCreateActiveConversation(tx, leadId)
		);

		// Dá tempo para a segunda transação atingir o SELECT e bloquear no lock.
		await new Promise((resolve) => setTimeout(resolve, 100));
		releaseFirst();

		const [first, second] = await Promise.all([
			firstTransaction,
			secondTransaction,
		]);

		assert.equal(first.conversation.id, second.conversation.id);
		assert.equal(await countActive(leadId), 1);
	} finally {
		await cleanup(leadId);
	}
});

test("o helper devolve a conversa ativa existente sem criar outra", async () => {
	const leadId = await createLead();

	try {
		const [existing] = await db
			.insert(conversations)
			.values({ leadId })
			.returning({ id: conversations.id });
		assert.ok(existing);

		const result = await db.transaction((tx) =>
			getOrCreateActiveConversation(tx, leadId)
		);

		assert.equal(result.conversation.id, existing.id);
		assert.equal(result.created, false);
		assert.equal(await countActive(leadId), 1);
	} finally {
		await cleanup(leadId);
	}
});

test("a rota POST /conversations continua idempotente", async () => {
	const leadId = await createLead();
	const app = buildApp();

	try {
		const first = await app.inject({
			method: "POST",
			payload: { leadId },
			url: "/conversations",
		});
		const second = await app.inject({
			method: "POST",
			payload: { leadId },
			url: "/conversations",
		});

		assert.equal(first.statusCode, 201);
		assert.equal(second.statusCode, 200);

		const firstBody = first.json<{ conversation: { id: string } }>();
		const secondBody = second.json<{ conversation: { id: string } }>();

		assert.equal(firstBody.conversation.id, secondBody.conversation.id);
		assert.equal(await countActive(leadId), 1);
	} finally {
		await app.close();
		await cleanup(leadId);
	}
});
