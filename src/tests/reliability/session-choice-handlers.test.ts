/** biome-ignore-all lint/suspicious/useAwait: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { and, eq } from "drizzle-orm";

import { closeDatabase, db } from "../../db/connections";
import { autonomousTasks } from "../../db/schema/autonomous-tasks";
import { conversations } from "../../db/schema/conversations";
import { leads } from "../../db/schema/leads";
import { messages } from "../../db/schema/messages";
import { outboundMessages } from "../../db/schema/outbound-messages";
import {
	ASK_SESSION_CHOICE_TASK,
	createAutonomousTaskHandlers,
	REMIND_SESSION_CHOICE_TASK,
} from "../../services/conversations/autonomous-task-handlers";
import { openSessionChoice } from "../../services/conversations/session-choice-store";

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

	return { conversationId: conversation.id, leadId: lead.id };
}

async function cleanup(leadId: string, conversationId: string) {
	await db
		.delete(outboundMessages)
		.where(eq(outboundMessages.conversationId, conversationId));
	await db
		.delete(autonomousTasks)
		.where(eq(autonomousTasks.conversationId, conversationId));
	await db.delete(messages).where(eq(messages.conversationId, conversationId));
	await db.delete(conversations).where(eq(conversations.id, conversationId));
	await db.delete(leads).where(eq(leads.id, leadId));
}

test("a pergunta é enviada uma vez com os dois botões e fica no histórico", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		await openSessionChoice({
			askedAt: new Date(),
			conversationId,
			leadId,
		});

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[ASK_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `ask:${conversationId}`,
				payload: {},
				status: "processing",
				taskType: ASK_SESSION_CHOICE_TASK,
			})
			.returning();

		const result1 = await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);
		assert.ok(result1);
		const result2 = await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);
		assert.ok(result2);

		const outs = await db
			.select()
			.from(outboundMessages)
			.where(eq(outboundMessages.conversationId, conversationId));
		assert.equal(outs.length, 1);
		const payload = outs[0].payload as any;
		assert.equal(payload.kind, "buttons");
		assert.deepEqual(
			payload.buttons.map((b: any) => b.id),
			["sessao:continuar", "sessao:nova"]
		);

		const assistantMsgs = await db
			.select()
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, conversationId),
					eq(messages.role, "assistant")
				)
			);
		assert.equal(assistantMsgs.length >= 1, true);
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("lembrete não cria pergunta duplicada nem processa a mensagem", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		await openSessionChoice({
			askedAt: new Date(),
			conversationId,
			leadId,
		});

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[REMIND_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `remind:${conversationId}`,
				payload: { eventExternalId: "wamid.test" },
				status: "processing",
				taskType: REMIND_SESSION_CHOICE_TASK,
			})
			.returning();

		await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);

		const outs = await db
			.select()
			.from(outboundMessages)
			.where(eq(outboundMessages.conversationId, conversationId));
		assert.equal(outs.length, 1);
		const payload = outs[0].payload as any;
		assert.equal(payload.kind, "buttons");
		assert.deepEqual(
			payload.buttons.map((b: any) => b.id),
			["sessao:continuar", "sessao:nova"]
		);

		const inboundTasks = await db
			.select()
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

test("sem estado pendente o handler não envia nada", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[ASK_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `ask:${conversationId}`,
				payload: {},
				status: "processing",
				taskType: ASK_SESSION_CHOICE_TASK,
			})
			.returning();

		const result = await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);
		assert.equal((result as any)?.skipped, true);

		const outs = await db
			.select()
			.from(outboundMessages)
			.where(eq(outboundMessages.conversationId, conversationId));
		assert.equal(outs.length, 0);
	} finally {
		await cleanup(leadId, conversationId);
	}
});
