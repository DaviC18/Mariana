/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { and, asc, eq } from "drizzle-orm";

import { closeDatabase, db } from "../../db/connections";
import { autonomousTasks } from "../../db/schema/autonomous-tasks";
import { conversations } from "../../db/schema/conversations";
import { leads } from "../../db/schema/leads";
import { messages } from "../../db/schema/messages";
import { outboundMessages } from "../../db/schema/outbound-messages";
import {
	createAutonomousTaskHandlers,
	PROCESS_INBOUND_MESSAGE_TASK,
	PROCESS_SESSION_CHOICE_TASK,
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
			name: `Lead Continue ${suffix}`,
			objective: "carro",
			phone: `551199${suffix.slice(-9)}`,
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
		.delete(outboundMessages)
		.where(eq(outboundMessages.conversationId, conversationId));
	await db
		.delete(autonomousTasks)
		.where(eq(autonomousTasks.conversationId, conversationId));
	await db.delete(messages).where(eq(messages.conversationId, conversationId));
	await db.delete(conversations).where(eq(conversations.id, conversationId));
	await db.delete(leads).where(eq(leads.id, leadId));
}

test("continuar mantém o mesmo conversationId e enfileira todas as mensagens pendentes em ordem", async () => {
	const { conversationId, leadId, suffix } = await createFixture();

	try {
		await openSessionChoice({
			askedAt: new Date(),
			conversationId,
			leadId,
		});

		const now = new Date();
		const [m1] = await db
			.insert(messages)
			.values({
				content: "mensagem 1",
				conversationId,
				createdAt: new Date(now.getTime() - 2000),
				externalId: `wamid.c1_${suffix}`,
				role: "user",
			})
			.returning({ createdAt: messages.createdAt, id: messages.id });
		const [m2] = await db
			.insert(messages)
			.values({
				content: "mensagem 2",
				conversationId,
				createdAt: new Date(now.getTime() - 1000),
				externalId: `wamid.c2_${suffix}`,
				role: "user",
			})
			.returning({ createdAt: messages.createdAt, id: messages.id });
		const [m3] = await db
			.insert(messages)
			.values({
				content: "mensagem 3",
				conversationId,
				createdAt: now,
				externalId: `wamid.c3_${suffix}`,
				role: "user",
			})
			.returning({ createdAt: messages.createdAt, id: messages.id });

		assert.ok(m1 && m2 && m3);

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `session-choice:${conversationId}`,
				payload: { buttonId: "sessao:continuar", kind: "button" },
				status: "processing",
				taskType: PROCESS_SESSION_CHOICE_TASK,
			})
			.returning();

		await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);

		const activeConvs = await db
			.select()
			.from(conversations)
			.where(
				and(
					eq(conversations.leadId, leadId),
					eq(conversations.status, "active")
				)
			);
		assert.equal(activeConvs.length, 1);
		assert.equal(activeConvs[0].id, conversationId);

		const inboundTasks = await db
			.select({
				createdAt: autonomousTasks.createdAt,
				payload: autonomousTasks.payload,
				triggerMessageId: autonomousTasks.triggerMessageId,
			})
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, conversationId),
					eq(autonomousTasks.taskType, PROCESS_INBOUND_MESSAGE_TASK)
				)
			)
			.orderBy(asc(autonomousTasks.createdAt));

		assert.equal(inboundTasks.length, 3);
		assert.equal(inboundTasks[0].triggerMessageId, m1.id);
		assert.equal(inboundTasks[1].triggerMessageId, m2.id);
		assert.equal(inboundTasks[2].triggerMessageId, m3.id);
		assert.equal(inboundTasks[0].createdAt.getTime(), m1.createdAt.getTime());
		assert.equal(inboundTasks[1].createdAt.getTime(), m2.createdAt.getTime());
		assert.equal(inboundTasks[2].createdAt.getTime(), m3.createdAt.getTime());

		const pendingMsgs = await db
			.select({ processedAt: messages.processedAt })
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, conversationId),
					eq(messages.role, "user")
				)
			);
		assert.equal(pendingMsgs.length, 3);
		for (const msg of pendingMsgs) {
			assert.equal(msg.processedAt, null);
		}
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("continuar preserva histórico e estado comercial", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		await db
			.update(leads)
			.set({ interestedInConsultant: true, objective: "carro" })
			.where(eq(leads.id, leadId));

		await db.insert(messages).values([
			{ content: "oi", conversationId, role: "user" },
			{ content: "ola", conversationId, role: "assistant" },
		]);

		await openSessionChoice({
			askedAt: new Date(),
			conversationId,
			leadId,
		});

		await db.insert(messages).values({
			content: "pendente",
			conversationId,
			role: "user",
		});

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `session-choice:${conversationId}`,
				payload: { buttonId: "sessao:continuar", kind: "button" },
				status: "processing",
				taskType: PROCESS_SESSION_CHOICE_TASK,
			})
			.returning();

		await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);

		const [lead] = await db
			.select({
				interestedInConsultant: leads.interestedInConsultant,
				objective: leads.objective,
			})
			.from(leads)
			.where(eq(leads.id, leadId));
		assert.equal(lead?.objective, "carro");
		assert.equal(lead?.interestedInConsultant, true);

		const historyCount = await db
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.conversationId, conversationId));
		assert.equal(historyCount.length, 3);
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("continuar não repete a pergunta de 24h", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		await openSessionChoice({
			askedAt: new Date(),
			conversationId,
			leadId,
		});

		const handlers = createAutonomousTaskHandlers();
		const handler = handlers[PROCESS_SESSION_CHOICE_TASK];
		assert.ok(handler);

		const [task] = await db
			.insert(autonomousTasks)
			.values({
				conversationId,
				idempotencyKey: `session-choice:${conversationId}`,
				payload: { buttonId: "sessao:continuar", kind: "button" },
				status: "processing",
				taskType: PROCESS_SESSION_CHOICE_TASK,
			})
			.returning();

		await handler({
			leaseToken: "t1",
			renewLease: async () => true,
			task,
		} as any);

		const pending = await db
			.select({ id: autonomousTasks.id, payload: autonomousTasks.payload })
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, conversationId),
					eq(autonomousTasks.taskType, "session_choice_state")
				)
			);
		assert.equal(pending.length, 1);
		assert.equal((pending[0].payload as any).state, "continue");
	} finally {
		await cleanup(leadId, conversationId);
	}
});
