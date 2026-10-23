/** biome-ignore-all lint/suspicious/useAwait: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";

import { closeDatabase, db } from "../../db/connections";
import { autonomousTasks } from "../../db/schema/autonomous-tasks";
import { conversations } from "../../db/schema/conversations";
import { leads } from "../../db/schema/leads";
import { messages } from "../../db/schema/messages";
import { executeNextAutonomousTask } from "../../services/conversations/autonomous-task-executor";
import { SESSION_CHOICE_STATE_TASK } from "../../services/conversations/autonomous-task-handlers";
import {
	claimSessionChoice,
	openSessionChoice,
	readPendingSessionChoice,
} from "../../services/conversations/session-choice-store";

test.after(async () => {
	await closeDatabase();
});

async function createFixture() {
	const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const [lead] = await db
		.insert(leads)
		.values({
			name: `Lead Session Choice ${suffix}`,
			phone: `551198${suffix.slice(-9)}`,
		})
		.returning({ id: leads.id });
	assert.ok(lead);

	const [conversation] = await db
		.insert(conversations)
		.values({ leadId: lead.id })
		.returning({ id: conversations.id });
	assert.ok(conversation);

	return { conversationId: conversation.id, leadId: lead.id, suffix };
}

async function cleanup(leadId: string, conversationId: string) {
	await db
		.delete(autonomousTasks)
		.where(eq(autonomousTasks.conversationId, conversationId));
	await db.delete(messages).where(eq(messages.conversationId, conversationId));
	await db.delete(conversations).where(eq(conversations.id, conversationId));
	await db.delete(leads).where(eq(leads.id, leadId));
}

test("o estado pendente sobrevive a uma nova leitura como se o processo tivesse reiniciado", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		const opened = await openSessionChoice({
			askedAt: new Date(),
			conversationId,
			leadId,
			triggerMessageId: undefined,
		});

		assert.equal(opened?.state, "pending");

		// Nova leitura sem cache: simula outro processo consultando o Postgres.
		const pending = await readPendingSessionChoice(conversationId);

		assert.equal(pending?.state, "pending");
		assert.equal(pending?.previousConversationId, conversationId);

		const [row] = await db
			.select({
				payload: autonomousTasks.payload,
				status: autonomousTasks.status,
				taskType: autonomousTasks.taskType,
			})
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, conversationId),
					eq(autonomousTasks.taskType, SESSION_CHOICE_STATE_TASK)
				)
			)
			.limit(1);

		assert.equal(row?.status, "completed");
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("dois claims concorrentes têm exatamente um vencedor", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		await openSessionChoice({
			askedAt: new Date(),
			conversationId,
			leadId,
		});

		const [first, second] = await Promise.all([
			claimSessionChoice({ conversationId, state: "continue" }),
			claimSessionChoice({ conversationId, state: "new" }),
		]);

		const winners = [first, second].filter((claim) => claim !== null);
		assert.equal(winners.length, 1);
		assert.equal(
			first === null || second === null,
			true,
			"one claim must lose"
		);

		const [row] = await db
			.select({ payload: autonomousTasks.payload })
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, conversationId),
					eq(autonomousTasks.taskType, SESSION_CHOICE_STATE_TASK)
				)
			)
			.limit(1);

		const state = row?.payload.state;
		assert.equal(winners[0]?.state, state);
		assert.equal(state === "continue" || state === "new", true);

		const stillPending = await readPendingSessionChoice(conversationId);
		assert.equal(stillPending, null);
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("a linha de estado não é reclamada pelo executor", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		await openSessionChoice({
			askedAt: new Date(),
			conversationId,
			leadId,
		});

		const result = await executeNextAutonomousTask({
			conversationId,
			handlers: {
				[SESSION_CHOICE_STATE_TASK]: async () => {
					throw new Error("state row must never be executed");
				},
			},
		});

		assert.equal(result.status, "idle");

		const pending = await readPendingSessionChoice(conversationId);
		assert.equal(pending?.state, "pending");
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("não existe task de inbound criada pela abertura do estado", async () => {
	const { conversationId, leadId, suffix } = await createFixture();

	try {
		await db.insert(messages).values({
			content: "mensagem pendente",
			conversationId,
			externalId: `wamid.session_choice_${suffix}`,
			role: "user",
		});

		await openSessionChoice({
			askedAt: new Date(),
			conversationId,
			leadId,
		});

		const inboundTasks = await db
			.select({ id: autonomousTasks.id })
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, conversationId),
					eq(autonomousTasks.taskType, "process_inbound_message")
				)
			);

		assert.equal(inboundTasks.length, 0);
	} finally {
		await cleanup(leadId, conversationId);
	}
});
