/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
/** biome-ignore-all lint/suspicious/noEvolvingTypes: <> */
/** biome-ignore-all lint/performance/noAwaitInLoops: <> */

import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import { db } from "../../db/connections";
import {
	consultants,
	conversations,
	leads,
	schedulingSessions,
	schedulingSlots,
} from "../../db/schema";
import { SchedulingCancellationService } from "../../services/calendar/scheduling-cancellation-service";

async function createCancellationFixture(slotCount: number) {
	const testPhone = `55119${Math.floor(
		10_000_000 + Math.random() * 90_000_000
	)}`;

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
			consortiumType: "automovel",
			interestedInConsultant: true,
			name: "Lead Teste Cancellation",
			objective: "Teste de cancelamento de agendamento",
			phone: testPhone,
			qualifiedAt: new Date(),
			status: "qualified",
		})
		.returning();

	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({
			leadId: lead.id,
		})
		.returning();

	assert.ok(conversation);

	const now = new Date();
	const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);

	const [session] = await db
		.insert(schedulingSessions)
		.values({
			conversationId: conversation.id,
			expiresAt,
			leadId: lead.id,
			status: "active",
		})
		.returning();

	assert.ok(session);

	const slots = [];

	for (let index = 0; index < slotCount; index += 1) {
		const startAt = new Date(`2026-10-0${index + 1}T10:00:00.000Z`);
		const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

		const [slot] = await db
			.insert(schedulingSlots)
			.values({
				calendarId: consultant.calendarId,
				consultantId: consultant.id,
				consultantName: consultant.name,
				endAt,
				position: index + 1,
				schedulingSessionId: session.id,
				startAt,
			})
			.returning();

		assert.ok(slot);

		slots.push(slot);
	}

	return {
		conversation,
		lead,
		session,
		slots,
	};
}

async function cleanupFixture({
	conversationId,
	leadId,
	sessionId,
}: {
	conversationId: string;
	leadId: string;
	sessionId: string;
}) {
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.id, sessionId));

	await db.delete(conversations).where(eq(conversations.id, conversationId));

	await db.delete(leads).where(eq(leads.id, leadId));
}

test("Não com 3 slots reapresenta a oferta e mantém a sessão ativa", async () => {
	const fixture = await createCancellationFixture(3);
	const service = new SchedulingCancellationService();

	try {
		const result = await service.resolveCancellation({
			buttonId: `cancel:${fixture.slots[1].id}`,
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
		});

		assert.equal(result.ok, true);

		if (!result.ok) {
			return;
		}

		assert.equal(result.action, "reoffer");
		assert.equal(result.session.status, "active");
		assert.equal(result.slots.length, 3);
		assert.deepEqual(
			result.slots.map((slot) => slot.position),
			[1, 2, 3]
		);
	} finally {
		await cleanupFixture({
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			sessionId: fixture.session.id,
		});
	}
});

test("Não com 2 slots reapresenta a oferta e mantém a sessão ativa", async () => {
	const fixture = await createCancellationFixture(2);
	const service = new SchedulingCancellationService();

	try {
		const result = await service.resolveCancellation({
			buttonId: `cancel:${fixture.slots[0].id}`,
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
		});

		assert.equal(result.ok, true);

		if (!result.ok) {
			return;
		}

		assert.equal(result.action, "reoffer");
		assert.equal(result.session.status, "active");
		assert.equal(result.slots.length, 2);
		assert.deepEqual(
			result.slots.map((slot) => slot.position),
			[1, 2]
		);
	} finally {
		await cleanupFixture({
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			sessionId: fixture.session.id,
		});
	}
});

test("Não com 1 slot fecha a sessão", async () => {
	const fixture = await createCancellationFixture(1);
	const service = new SchedulingCancellationService();

	try {
		const result = await service.resolveCancellation({
			buttonId: `cancel:${fixture.slots[0].id}`,
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
		});

		assert.equal(result.ok, true);

		if (!result.ok) {
			return;
		}

		assert.equal(result.action, "close");
		assert.equal(result.session.status, "closed");
		assert.equal(result.slots.length, 1);

		const [storedSession] = await db
			.select()
			.from(schedulingSessions)
			.where(eq(schedulingSessions.id, fixture.session.id));

		assert.ok(storedSession);
		assert.equal(storedSession.status, "closed");
	} finally {
		await cleanupFixture({
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			sessionId: fixture.session.id,
		});
	}
});

test("Não rejeita sessão fechada", async () => {
	const fixture = await createCancellationFixture(2);
	const service = new SchedulingCancellationService();

	try {
		await db
			.update(schedulingSessions)
			.set({
				status: "closed",
				updatedAt: new Date(),
			})
			.where(eq(schedulingSessions.id, fixture.session.id));

		const result = await service.resolveCancellation({
			buttonId: `cancel:${fixture.slots[0].id}`,
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
		});

		assert.equal(result.ok, false);
	} finally {
		await cleanupFixture({
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			sessionId: fixture.session.id,
		});
	}
});

test("Não rejeita sessão expirada", async () => {
	const fixture = await createCancellationFixture(2);
	const service = new SchedulingCancellationService();

	try {
		await db
			.update(schedulingSessions)
			.set({
				expiresAt: new Date(Date.now() - 60_000),
				updatedAt: new Date(),
			})
			.where(eq(schedulingSessions.id, fixture.session.id));

		const result = await service.resolveCancellation({
			buttonId: `cancel:${fixture.slots[0].id}`,
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
		});

		assert.equal(result.ok, false);
	} finally {
		await cleanupFixture({
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			sessionId: fixture.session.id,
		});
	}
});

test("Não rejeita buttonId que não representa cancelamento", async () => {
	const fixture = await createCancellationFixture(2);
	const service = new SchedulingCancellationService();

	try {
		const result = await service.resolveCancellation({
			buttonId: `confirm:${fixture.slots[0].id}`,
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
		});

		assert.equal(result.ok, false);
	} finally {
		await cleanupFixture({
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			sessionId: fixture.session.id,
		});
	}
});
