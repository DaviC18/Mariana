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
import { SchedulingChoiceService } from "../../services/calendar/scheduling-choice-service";

const schedulingChoiceService = new SchedulingChoiceService();

async function createFixture() {
	const suffix = Date.now().toString();

	const [consultant] = await db
		.select({
			calendarId: consultants.calendarId,
			id: consultants.id,
			name: consultants.name,
		})
		.from(consultants)
		.where(eq(consultants.active, true))
		.limit(1);

	assert.ok(consultant);

	const [lead] = await db
		.insert(leads)
		.values({
			name: `Lead Choice ${suffix}`,
			phone: `551199${suffix.slice(-8)}`,
			objective: "Teste de seleção de horário",
			consortiumType: "automovel",
			status: "qualified",
		})
		.returning({
			id: leads.id,
		});

	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({
			leadId: lead.id,
		})
		.returning({
			id: conversations.id,
		});

	assert.ok(conversation);

	const now = new Date();
	const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);

	const [session] = await db
		.insert(schedulingSessions)
		.values({
			leadId: lead.id,
			conversationId: conversation.id,
			status: "active",
			expiresAt,
		})
		.returning();

	assert.ok(session);

	const startAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
	const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

	const [slot] = await db
		.insert(schedulingSlots)
		.values({
			schedulingSessionId: session.id,
			position: 1,
			consultantId: consultant.id,
			consultantName: consultant.name,
			calendarId: consultant.calendarId,
			startAt,
			endAt,
		})
		.returning();

	assert.ok(slot);

	return {
		consultant,
		conversation,
		lead,
		session,
		slot,
		now,
	};
}

async function cleanupFixture(
	leadId: string,
	conversationId: string,
	sessionId: string
) {
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.id, sessionId));

	await db.delete(conversations).where(eq(conversations.id, conversationId));

	await db.delete(leads).where(eq(leads.id, leadId));
}

test("resolve seleção válida pelo ID persistido do slot", async () => {
	const fixture = await createFixture();

	try {
		const result = await schedulingChoiceService.resolveChoice({
			buttonId: fixture.slot.id,
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			now: fixture.now,
		});

		assert.equal(result.ok, true);

		if (!result.ok) {
			return;
		}

		assert.equal(result.slot.id, fixture.slot.id);
		assert.equal(result.session.id, fixture.session.id);
		assert.equal(result.slot.schedulingSessionId, fixture.session.id);
		assert.equal(result.session.leadId, fixture.lead.id);
		assert.equal(result.session.conversationId, fixture.conversation.id);
	} finally {
		await cleanupFixture(
			fixture.lead.id,
			fixture.conversation.id,
			fixture.session.id
		);
	}
});

test("rejeita buttonId que não é UUID", async () => {
	const result = await schedulingChoiceService.resolveChoice({
		buttonId: "1",
		conversationId: "00000000-0000-4000-8000-000000000002",
		leadId: "00000000-0000-4000-8000-000000000003",
	});

	assert.deepEqual(result, {
		ok: false,
		reason: "invalid_button",
	});
});

test("rejeita slot inexistente", async () => {
	const result = await schedulingChoiceService.resolveChoice({
		buttonId: "00000000-0000-4000-8000-000000000004",
		conversationId: "00000000-0000-4000-8000-000000000005",
		leadId: "00000000-0000-4000-8000-000000000006",
	});

	assert.deepEqual(result, {
		ok: false,
		reason: "invalid_slot",
	});
});

test("rejeita seleção quando o lead não corresponde à sessão", async () => {
	const fixture = await createFixture();

	try {
		const result = await schedulingChoiceService.resolveChoice({
			buttonId: fixture.slot.id,
			conversationId: fixture.conversation.id,
			leadId: "00000000-0000-4000-8000-000000000007",
			now: fixture.now,
		});

		assert.deepEqual(result, {
			ok: false,
			reason: "slot_from_another_session",
		});
	} finally {
		await cleanupFixture(
			fixture.lead.id,
			fixture.conversation.id,
			fixture.session.id
		);
	}
});

test("rejeita seleção quando a conversa não corresponde à sessão", async () => {
	const fixture = await createFixture();

	const [otherConversation] = await db
		.insert(conversations)
		.values({
			leadId: fixture.lead.id,
		})
		.returning({
			id: conversations.id,
		});

	assert.ok(otherConversation);

	try {
		const result = await schedulingChoiceService.resolveChoice({
			buttonId: fixture.slot.id,
			conversationId: otherConversation.id,
			leadId: fixture.lead.id,
			now: fixture.now,
		});

		assert.deepEqual(result, {
			ok: false,
			reason: "slot_from_another_session",
		});
	} finally {
		await db
			.delete(conversations)
			.where(eq(conversations.id, otherConversation.id));

		await cleanupFixture(
			fixture.lead.id,
			fixture.conversation.id,
			fixture.session.id
		);
	}
});

test("rejeita sessão que não está ativa", async () => {
	const fixture = await createFixture();

	try {
		await db
			.update(schedulingSessions)
			.set({
				status: "closed",
			})
			.where(eq(schedulingSessions.id, fixture.session.id));

		const result = await schedulingChoiceService.resolveChoice({
			buttonId: fixture.slot.id,
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			now: fixture.now,
		});

		assert.deepEqual(result, {
			ok: false,
			reason: "no_active_session",
		});
	} finally {
		await cleanupFixture(
			fixture.lead.id,
			fixture.conversation.id,
			fixture.session.id
		);
	}
});

test("rejeita sessão expirada mesmo que o status ainda seja active", async () => {
	const fixture = await createFixture();

	try {
		const expiredNow = new Date(fixture.session.expiresAt.getTime() + 1);

		const result = await schedulingChoiceService.resolveChoice({
			buttonId: fixture.slot.id,
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			now: expiredNow,
		});

		assert.deepEqual(result, {
			ok: false,
			reason: "expired",
		});
	} finally {
		await cleanupFixture(
			fixture.lead.id,
			fixture.conversation.id,
			fixture.session.id
		);
	}
});
