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
import { SchedulingConfirmationService } from "../../services/calendar/scheduling-confirmation-service";

const schedulingConfirmationService = new SchedulingConfirmationService();

async function createFixture() {
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

	assert.ok(consultant, "Um consultor ativo deveria existir");

	const [lead] = await db
		.insert(leads)
		.values({
			consortiumType: "geral",
			name: `Lead Confirmation ${Date.now()}`,
			objective: "Teste de confirmação",
			phone: testPhone,
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
			conversationId: conversation.id,
			createdAt: now,
			expiresAt,
			leadId: lead.id,
			status: "active",
			updatedAt: now,
		})
		.returning();

	assert.ok(session);

	const startAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

	const endAt = new Date(startAt.getTime() + 30 * 60 * 1000);

	const [slot] = await db
		.insert(schedulingSlots)
		.values({
			calendarId: consultant.calendarId,
			consultantId: consultant.id,
			consultantName: consultant.name,
			createdAt: now,
			endAt,
			position: 1,
			schedulingSessionId: session.id,
			startAt,
		})
		.returning();

	assert.ok(slot);

	return {
		conversation,
		lead,
		now,
		session,
		slot,
	};
}

async function cleanupFixture({
	leadId,
	conversationId,
	sessionId,
}: {
	leadId: string;
	conversationId: string;
	sessionId: string;
}) {
	await db
		.delete(schedulingSessions)
		.where(eq(schedulingSessions.id, sessionId));

	await db.delete(conversations).where(eq(conversations.id, conversationId));

	await db.delete(leads).where(eq(leads.id, leadId));
}

/**
 * 11.5-A — interpretação da ação de confirmação
 */

test("resolve ação confirm com slot UUID válido", () => {
	const slotId = "550e8400-e29b-41d4-a716-446655440000";

	const result = schedulingConfirmationService.resolveAction(
		`confirm:${slotId}`
	);

	assert.deepEqual(result, {
		action: "confirm",
		ok: true,
		slotId,
	});
});

test("resolve ação cancel com slot UUID válido", () => {
	const slotId = "550e8400-e29b-41d4-a716-446655440001";

	const result = schedulingConfirmationService.resolveAction(
		`cancel:${slotId}`
	);

	assert.deepEqual(result, {
		action: "cancel",
		ok: true,
		slotId,
	});
});

test("rejeita ação desconhecida", () => {
	const slotId = "550e8400-e29b-41d4-a716-446655440002";

	const result = schedulingConfirmationService.resolveAction(
		`reject:${slotId}`
	);

	assert.deepEqual(result, {
		ok: false,
		reason: "invalid_action",
	});
});

test("rejeita buttonId sem separador", () => {
	const result = schedulingConfirmationService.resolveAction("confirm");

	assert.deepEqual(result, {
		ok: false,
		reason: "invalid_action",
	});
});

test("rejeita slotId inválido", () => {
	const result =
		schedulingConfirmationService.resolveAction("confirm:not-a-uuid");

	assert.deepEqual(result, {
		ok: false,
		reason: "invalid_slot",
	});
});

test("rejeita slotId vazio", () => {
	const result = schedulingConfirmationService.resolveAction("cancel:");

	assert.deepEqual(result, {
		ok: false,
		reason: "invalid_slot",
	});
});

/**
 * 11.5-B — validação contra a sessão persistida
 */

test("resolve confirm com slot pertencente à sessão ativa", async () => {
	const fixture = await createFixture();

	try {
		const result = await schedulingConfirmationService.resolveConfirmation({
			buttonId: `confirm:${fixture.slot.id}`,
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			now: fixture.now,
		});

		assert.equal(result.ok, true);

		if (!result.ok) {
			return;
		}

		assert.equal(result.action, "confirm");
		assert.equal(result.slot.id, fixture.slot.id);
		assert.equal(result.session.id, fixture.session.id);
		assert.equal(result.session.leadId, fixture.lead.id);
		assert.equal(result.session.conversationId, fixture.conversation.id);
		assert.equal(result.session.status, "active");
	} finally {
		await cleanupFixture({
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			sessionId: fixture.session.id,
		});
	}
});

test("resolve cancel com slot pertencente à sessão ativa", async () => {
	const fixture = await createFixture();

	try {
		const result = await schedulingConfirmationService.resolveConfirmation({
			buttonId: `cancel:${fixture.slot.id}`,
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			now: fixture.now,
		});

		assert.equal(result.ok, true);

		if (!result.ok) {
			return;
		}

		assert.equal(result.action, "cancel");
		assert.equal(result.slot.id, fixture.slot.id);
		assert.equal(result.session.id, fixture.session.id);
		assert.equal(result.session.status, "active");
	} finally {
		await cleanupFixture({
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			sessionId: fixture.session.id,
		});
	}
});

test("rejeita confirmação quando o lead não corresponde à sessão", async () => {
	const fixture = await createFixture();

	try {
		const result = await schedulingConfirmationService.resolveConfirmation({
			buttonId: `confirm:${fixture.slot.id}`,
			conversationId: fixture.conversation.id,
			leadId: "00000000-0000-4000-8000-000000000007",
			now: fixture.now,
		});

		assert.deepEqual(result, {
			ok: false,
			reason: "slot_from_another_session",
		});
	} finally {
		await cleanupFixture({
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			sessionId: fixture.session.id,
		});
	}
});

test("rejeita confirmação quando a conversa não corresponde à sessão", async () => {
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
		const result = await schedulingConfirmationService.resolveConfirmation({
			buttonId: `confirm:${fixture.slot.id}`,
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

		await cleanupFixture({
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			sessionId: fixture.session.id,
		});
	}
});

test("rejeita confirmação quando a sessão está fechada", async () => {
	const fixture = await createFixture();

	try {
		await db
			.update(schedulingSessions)
			.set({
				status: "closed",
			})
			.where(eq(schedulingSessions.id, fixture.session.id));

		const result = await schedulingConfirmationService.resolveConfirmation({
			buttonId: `confirm:${fixture.slot.id}`,
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			now: fixture.now,
		});

		assert.deepEqual(result, {
			ok: false,
			reason: "no_active_session",
		});
	} finally {
		await cleanupFixture({
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			sessionId: fixture.session.id,
		});
	}
});

test("rejeita confirmação quando a sessão está expirada", async () => {
	const fixture = await createFixture();

	try {
		const expiredNow = new Date(fixture.session.expiresAt.getTime() + 1);

		const result = await schedulingConfirmationService.resolveConfirmation({
			buttonId: `confirm:${fixture.slot.id}`,
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			now: expiredNow,
		});

		assert.deepEqual(result, {
			ok: false,
			reason: "expired",
		});
	} finally {
		await cleanupFixture({
			conversationId: fixture.conversation.id,
			leadId: fixture.lead.id,
			sessionId: fixture.session.id,
		});
	}
});

/**
 * 11.5-C.1 — montagem da mensagem de confirmação
 */

test("monta mensagem de confirmação com data e consultor", () => {
	const slotId = "550e8400-e29b-41d4-a716-446655440010";

	const startAt = new Date("2026-09-29T10:00:00-03:00");

	const result = schedulingConfirmationService.buildConfirmationMessage({
		consultantName: "João Silva",
		id: slotId,
		startAt,
	});

	assert.match(result.body, /João Silva/);

	assert.match(result.body, /Terça-feira, 29 de setembro às 10:00/);
});

test("inclui botão de confirmação com slotId persistido", () => {
	const slotId = "550e8400-e29b-41d4-a716-446655440011";

	const result = schedulingConfirmationService.buildConfirmationMessage({
		consultantName: "João Silva",
		id: slotId,
		startAt: new Date("2026-09-29T10:00:00-03:00"),
	});

	assert.ok(
		result.buttons.some(
			(button) =>
				button.id === `confirm:${slotId}` && button.title === "Confirmar"
		)
	);
});

test("inclui botão de cancelamento com slotId persistido", () => {
	const slotId = "550e8400-e29b-41d4-a716-446655440012";

	const result = schedulingConfirmationService.buildConfirmationMessage({
		consultantName: "Maria Souza",
		id: slotId,
		startAt: new Date("2026-09-29T10:00:00-03:00"),
	});

	assert.ok(
		result.buttons.some(
			(button) => button.id === `cancel:${slotId}` && button.title === "Não"
		)
	);
});

test("gera exatamente os dois botões de confirmação", () => {
	const slotId = "550e8400-e29b-41d4-a716-446655440013";

	const result = schedulingConfirmationService.buildConfirmationMessage({
		consultantName: "Carlos Oliveira",
		id: slotId,
		startAt: new Date("2026-09-29T10:00:00-03:00"),
	});

	assert.deepEqual(result.buttons, [
		{
			id: `confirm:${slotId}`,
			title: "Confirmar",
		},
		{
			id: `cancel:${slotId}`,
			title: "Não",
		},
	]);
});
