/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/style/useDestructuring: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */
/** biome-ignore-all lint/performance/useTopLevelRegex: <> */

import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import { db } from "../../db/connections";
import { consultants } from "../../db/schema/consultants";
import { conversations } from "../../db/schema/conversations";
import { leads } from "../../db/schema/leads";
import { schedulingSessions } from "../../db/schema/scheduling-sessions";
import { schedulingSlots } from "../../db/schema/scheduling-slots";

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

test("TESTE 5 & Concorrência — banco proíbe duas sessões com status active para o mesmo lead", async () => {
	const TEST_PHONE = `5511904${Date.now().toString().slice(-6)}`;

	const [lead] = await db
		.insert(leads)
		.values({
			name: "Lead Active Constraint Test",
			phone: TEST_PHONE,
			objective: "Teste Unique Active",
			consortiumType: "automovel",
		})
		.returning({ id: leads.id });

	const [conversation] = await db
		.insert(conversations)
		.values({
			leadId: lead.id,
		})
		.returning({ id: conversations.id });

	const [firstSession] = await db
		.insert(schedulingSessions)
		.values({
			leadId: lead.id,
			conversationId: conversation.id,
			status: "active",
			expiresAt: new Date(Date.now() + 15 * 60 * 1000),
		})
		.returning({ id: schedulingSessions.id });

	assert.ok(firstSession);

	await assert.rejects(
		async () => {
			await db.insert(schedulingSessions).values({
				leadId: lead.id,
				conversationId: conversation.id,
				status: "active",
				expiresAt: new Date(Date.now() + 15 * 60 * 1000),
			});
		},
		(err: any) => {
			const code = err.code || err.cause?.code;
			const message = err.message || "";
			return (
				code === "23505" ||
				message.includes("scheduling_sessions_one_active_lead_unique")
			);
		}
	);

	// Permite inserir uma sessão closed
	const [closedSession] = await db
		.insert(schedulingSessions)
		.values({
			leadId: lead.id,
			conversationId: conversation.id,
			status: "closed",
			expiresAt: new Date(Date.now() + 15 * 60 * 1000),
		})
		.returning({ id: schedulingSessions.id });

	assert.ok(closedSession);

	// Cleanup
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.leadId, lead.id));
	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("TESTE 7 — valida constraint unique(schedulingSessionId, position)", async () => {
	const TEST_PHONE = `5511905${Date.now().toString().slice(-6)}`;

	const [consultant] = await db
		.select({
			id: consultants.id,
			name: consultants.name,
			calendarId: consultants.calendarId,
		})
		.from(consultants)
		.where(eq(consultants.active, true))
		.limit(1);

	assert.ok(consultant);

	const [lead] = await db
		.insert(leads)
		.values({
			name: "Lead Unique Position Test",
			phone: TEST_PHONE,
			objective: "Teste Position Unique",
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
			expiresAt: new Date(Date.now() + 15 * 60 * 1000),
		})
		.returning({ id: schedulingSessions.id });

	const startAt = new Date("2026-09-24T14:00:00.000Z");
	const endAt = new Date("2026-09-24T14:30:00.000Z");

	await db.insert(schedulingSlots).values({
		calendarId: consultant.calendarId,
		consultantId: consultant.id,
		consultantName: consultant.name,
		endAt,
		position: 1,
		schedulingSessionId: session.id,
		startAt,
	});

	await assert.rejects(
		async () => {
			await db.insert(schedulingSlots).values({
				calendarId: consultant.calendarId,
				consultantId: consultant.id,
				consultantName: consultant.name,
				endAt: new Date("2026-09-24T15:30:00.000Z"),
				position: 1, // posição repetida
				schedulingSessionId: session.id,
				startAt: new Date("2026-09-24T15:00:00.000Z"),
			});
		},
		(err: any) => {
			const code = err.code || err.cause?.code;
			const message = err.message || "";
			return (
				code === "23505" ||
				message.includes("scheduling_slots_session_position_unique")
			);
		}
	);

	// Cleanup
	await db
		.delete(schedulingSlots)
		.where(eq(schedulingSlots.schedulingSessionId, session.id));
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.id, session.id));
	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("TESTE 8 — valida FK scheduling_slots.schedulingSessionId e comportamento ON DELETE CASCADE", async () => {
	const TEST_PHONE = `5511906${Date.now().toString().slice(-6)}`;

	const [consultant] = await db
		.select({
			id: consultants.id,
			name: consultants.name,
			calendarId: consultants.calendarId,
		})
		.from(consultants)
		.where(eq(consultants.active, true))
		.limit(1);

	assert.ok(consultant);

	const [lead] = await db
		.insert(leads)
		.values({
			name: "Lead Cascade Slots Test",
			phone: TEST_PHONE,
			objective: "Teste Cascade Slots",
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
			expiresAt: new Date(Date.now() + 15 * 60 * 1000),
		})
		.returning({ id: schedulingSessions.id });

	const [slot] = await db
		.insert(schedulingSlots)
		.values({
			calendarId: consultant.calendarId,
			consultantId: consultant.id,
			consultantName: consultant.name,
			endAt: new Date("2026-09-24T14:30:00.000Z"),
			position: 1,
			schedulingSessionId: session.id,
			startAt: new Date("2026-09-24T14:00:00.000Z"),
		})
		.returning({ id: schedulingSlots.id });

	assert.ok(slot);

	// Deletar a sessão deve deletar os slots por CASCADE
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.id, session.id));

	const remainingSlots = await db
		.select()
		.from(schedulingSlots)
		.where(eq(schedulingSlots.id, slot.id));

	assert.equal(
		remainingSlots.length,
		0,
		"Slots deveriam ter sido deletados via cascade"
	);

	// Cleanup
	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});

test("TESTE 9 — valida CHECK startAt < endAt e position > 0 em scheduling_slots", async () => {
	const TEST_PHONE = `5511907${Date.now().toString().slice(-6)}`;

	const [consultant] = await db
		.select({
			id: consultants.id,
			name: consultants.name,
			calendarId: consultants.calendarId,
		})
		.from(consultants)
		.where(eq(consultants.active, true))
		.limit(1);

	assert.ok(consultant);

	const [lead] = await db
		.insert(leads)
		.values({
			name: "Lead Check Slots Test",
			phone: TEST_PHONE,
			objective: "Teste Checks Slots",
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
			expiresAt: new Date(Date.now() + 15 * 60 * 1000),
		})
		.returning({ id: schedulingSessions.id });

	// 1. Testa startAt >= endAt
	await assert.rejects(
		async () => {
			await db.insert(schedulingSlots).values({
				calendarId: consultant.calendarId,
				consultantId: consultant.id,
				consultantName: consultant.name,
				endAt: new Date("2026-09-24T14:00:00.000Z"),
				position: 1,
				schedulingSessionId: session.id,
				startAt: new Date("2026-09-24T14:30:00.000Z"), // start após end
			});
		},
		(err: any) => {
			const code = err.code || err.cause?.code;
			const message = err.message || "";
			return (
				code === "23514" ||
				message.includes("scheduling_slots_valid_time_range_check")
			);
		}
	);

	// 2. Testa position <= 0
	await assert.rejects(
		async () => {
			await db.insert(schedulingSlots).values({
				calendarId: consultant.calendarId,
				consultantId: consultant.id,
				consultantName: consultant.name,
				endAt: new Date("2026-09-24T14:30:00.000Z"),
				position: 0, // position inválida
				schedulingSessionId: session.id,
				startAt: new Date("2026-09-24T14:00:00.000Z"),
			});
		},
		(err: any) => {
			const code = err.code || err.cause?.code;
			const message = err.message || "";
			return (
				code === "23514" ||
				message.includes("scheduling_slots_position_positive_check")
			);
		}
	);

	// Cleanup
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.id, session.id));
	await db.delete(conversations).where(eq(conversations.id, conversation.id));
	await db.delete(leads).where(eq(leads.id, lead.id));
});
