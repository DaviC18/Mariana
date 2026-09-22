/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useDestructuring: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */
/** biome-ignore-all lint/performance/useTopLevelRegex: <> */

import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import { db } from "../../db/connections";
import { conversations } from "../../db/schema/conversations";
import { leads } from "../../db/schema/leads";
import { schedulingSessions } from "../../db/schema/scheduling-sessions";

test("cria sessão de agendamento válida e verifica defaults", async () => {
	const TEST_PHONE = `5511900${Date.now().toString().slice(-6)}`;

	const [lead] = await db
		.insert(leads)
		.values({
			name: "Lead Test Session",
			phone: TEST_PHONE,
			objective: "Teste de sessão",
			consortiumType: "automovel",
			status: "qualified",
		})
		.returning({ id: leads.id });

	const [conversation] = await db
		.insert(conversations)
		.values({
			leadId: lead.id,
		})
		.returning({ id: conversations.id });

	const expiresAt = new Date();
	expiresAt.setHours(expiresAt.getHours() + 24);

	const [session] = await db
		.insert(schedulingSessions)
		.values({
			leadId: lead.id,
			conversationId: conversation.id,
			expiresAt,
		})
		.returning();

	assert.ok(session);
	assert.equal(session.status, "active");
	assert.ok(session.createdAt);
	assert.equal(session.leadId, lead.id);
	assert.equal(session.conversationId, conversation.id);

	// Cleanup
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.id, session.id));
	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("verifica integridade da FK de Conversation (CASCADE)", async () => {
	const TEST_PHONE = `5511901${Date.now().toString().slice(-6)}`;

	const [lead] = await db
		.insert(leads)
		.values({
			name: "Lead Cascade Test",
			phone: TEST_PHONE,
			objective: "Teste Cascade",
			consortiumType: "automovel",
		})
		.returning({ id: leads.id });

	const [conversation] = await db
		.insert(conversations)
		.values({
			leadId: lead.id,
		})
		.returning({ id: conversations.id });

	const [session] = await db
		.insert(schedulingSessions)
		.values({
			leadId: lead.id,
			conversationId: conversation.id,
			expiresAt: new Date(),
		})
		.returning({ id: schedulingSessions.id });

	// Delete conversation
	await db.delete(conversations).where(eq(conversations.id, conversation.id));

	const foundSession = await db
		.select()
		.from(schedulingSessions)
		.where(eq(schedulingSessions.id, session.id))
		.limit(1);

	assert.equal(
		foundSession.length,
		0,
		"Sessão deveria ter sido deletada via cascade"
	);

	// Cleanup
	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("verifica integridade da FK de Lead (RESTRICT)", async () => {
	const TEST_PHONE = `5511902${Date.now().toString().slice(-6)}`;

	const [lead] = await db
		.insert(leads)
		.values({
			name: "Lead Restrict Test",
			phone: TEST_PHONE,
			objective: "Teste Restrict",
			consortiumType: "automovel",
		})
		.returning({ id: leads.id });

	const [conversation] = await db
		.insert(conversations)
		.values({
			leadId: lead.id,
		})
		.returning({ id: conversations.id });

	await db.insert(schedulingSessions).values({
		leadId: lead.id,
		conversationId: conversation.id,
		expiresAt: new Date(),
	});

	try {
		await db.delete(leads).where(eq(leads.id, lead.id));
		assert.fail("Deveria ter lançado erro de FK Restrict");
	} catch (e: any) {
		const errorMessage = e.message || "";
		const isFkError =
			e.code === "23503" ||
			errorMessage.includes("foreign key constraint") ||
			errorMessage.includes('delete from "leads"');

		assert.ok(
			isFkError,
			`Esperava erro de FK Restrict, mas recebeu: ${errorMessage}`
		);
	}

	// Cleanup
	const [session] = await db
		.select()
		.from(schedulingSessions)
		.where(eq(schedulingSessions.leadId, lead.id))
		.limit(1);
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.id, session.id));
	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("verifica relações via Drizzle", async () => {
	const TEST_PHONE = `5511903${Date.now().toString().slice(-6)}`;

	const [lead] = await db
		.insert(leads)
		.values({
			name: "Lead Relation Test",
			phone: TEST_PHONE,
			objective: "Teste Relation",
			consortiumType: "automovel",
		})
		.returning({ id: leads.id });

	const [conversation] = await db
		.insert(conversations)
		.values({
			leadId: lead.id,
		})
		.returning({ id: conversations.id });

	const [session] = await db
		.insert(schedulingSessions)
		.values({
			leadId: lead.id,
			conversationId: conversation.id,
			expiresAt: new Date(),
		})
		.returning({ id: schedulingSessions.id });

	try {
		const result = await db
			.select()
			.from(schedulingSessions)
			.innerJoin(leads, eq(schedulingSessions.leadId, leads.id))
			.innerJoin(
				conversations,
				eq(schedulingSessions.conversationId, conversations.id)
			)
			.where(eq(schedulingSessions.id, session.id));

		assert.ok(result.length > 0);
		assert.equal(result[0].leads.id, lead.id);
		assert.equal(result[0].conversations.id, conversation.id);
	} catch (e: any) {
		console.error("Relation error:", e);
		throw e;
	}

	// Cleanup
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.id, session.id));
	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});
