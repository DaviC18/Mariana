/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
/**
 * Adversarial cases for Steps 6–7 (plan Steps 11–12 subset that only needs the
 * `process_session_choice` handler): duplicate/out-of-order taps, restart with a
 * durable pending state, and "never two active conversations".
 */
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
import { SESSION_CHOICE_ALREADY_RECORDED_TEXT } from "../../services/conversations/session-choice-policy";
import {
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
			interestedInConsultant: true,
			name: `Lead Adversarial ${suffix}`,
			objective: "consórcio de carro",
			phone: `551194${suffix.slice(-9)}`,
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

async function cleanup(leadId: string) {
	const convs = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(eq(conversations.leadId, leadId));
	for (const conv of convs) {
		await db
			.delete(outboundMessages)
			.where(eq(outboundMessages.conversationId, conv.id));
		await db
			.delete(autonomousTasks)
			.where(eq(autonomousTasks.conversationId, conv.id));
		await db.delete(messages).where(eq(messages.conversationId, conv.id));
	}
	await db.delete(conversations).where(eq(conversations.leadId, leadId));
	await db.delete(leads).where(eq(leads.id, leadId));
}

async function tapChoice({
	buttonId,
	conversationId,
	externalId,
	extraPayload = {},
}: {
	buttonId: string;
	conversationId: string;
	externalId: string;
	extraPayload?: Record<string, unknown>;
}) {
	const handler = createAutonomousTaskHandlers()[PROCESS_SESSION_CHOICE_TASK];
	assert.ok(handler);

	const [task] = await db
		.insert(autonomousTasks)
		.values({
			conversationId,
			idempotencyKey: `session-choice:${externalId}`,
			payload: {
				buttonId,
				eventExternalId: externalId,
				kind: "button",
				...extraPayload,
			},
			status: "processing",
			taskType: PROCESS_SESSION_CHOICE_TASK,
		})
		.returning();

	return handler({
		leaseToken: "t1",
		renewLease: async () => true,
		task,
	} as any);
}

test("continuar e depois nova: a primeira escolha vence e a segunda só informa", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
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

		await tapChoice({
			buttonId: "sessao:continuar",
			conversationId,
			externalId: `wamid.adv1a_${Date.now()}`,
		});
		await tapChoice({
			buttonId: "sessao:nova",
			conversationId,
			externalId: `wamid.adv1b_${Date.now()}`,
		});

		const convs = await db
			.select({ id: conversations.id, status: conversations.status })
			.from(conversations)
			.where(eq(conversations.leadId, leadId));
		assert.equal(convs.length, 1);
		assert.equal(convs[0].id, conversationId);
		assert.equal(convs[0].status, "active");

		const state = await readPendingSessionChoice(conversationId);
		assert.equal(state, null);

		const [stateRow] = await db
			.select({ payload: autonomousTasks.payload })
			.from(autonomousTasks)
			.where(
				eq(
					autonomousTasks.idempotencyKey,
					`session-choice-state:${conversationId}`
				)
			);
		assert.equal((stateRow.payload as any).state, "continue");

		const outs = await db
			.select({ payload: outboundMessages.payload })
			.from(outboundMessages)
			.where(eq(outboundMessages.conversationId, conversationId));
		const alreadyRecorded = outs.filter(
			(o) => (o.payload as any).text === SESSION_CHOICE_ALREADY_RECORDED_TEXT
		);
		assert.equal(alreadyRecorded.length, 1);
	} finally {
		await cleanup(leadId);
	}
});

test("nova e depois continuar: B é a única ativa e A continua fechada", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
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

		await tapChoice({
			buttonId: "sessao:nova",
			conversationId,
			externalId: `wamid.adv2a_${Date.now()}`,
		});
		await tapChoice({
			buttonId: "sessao:continuar",
			conversationId,
			externalId: `wamid.adv2b_${Date.now()}`,
		});

		const convs = await db
			.select({ id: conversations.id, status: conversations.status })
			.from(conversations)
			.where(eq(conversations.leadId, leadId));
		assert.equal(convs.length, 2);
		const active = convs.filter((c) => c.status === "active");
		assert.equal(active.length, 1);
		assert.notEqual(active[0].id, conversationId);

		const [a] = await db
			.select({ status: conversations.status })
			.from(conversations)
			.where(eq(conversations.id, conversationId));
		assert.equal(a.status, "closed");
	} finally {
		await cleanup(leadId);
	}
});

test("estado pendente sobrevive a restart e a escolha ainda é aplicada", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
		// "Process A" opens the durable state.
		await openSessionChoice({
			askedAt: new Date(),
			conversationId,
			leadId,
		});
		const [m1] = await db
			.insert(messages)
			.values({ content: "msg1", conversationId, role: "user" })
			.returning({ id: messages.id });
		const [m2] = await db
			.insert(messages)
			.values({ content: "msg2", conversationId, role: "user" })
			.returning({ id: messages.id });
		assert.ok(m1 && m2);

		// "Process B" reads the state fresh from Postgres and applies it.
		const pending = await readPendingSessionChoice(conversationId);
		assert.equal(pending?.state, "pending");

		await tapChoice({
			buttonId: "sessao:continuar",
			conversationId,
			externalId: `wamid.adv3_${Date.now()}`,
		});

		const [a] = await db
			.select({ status: conversations.status })
			.from(conversations)
			.where(eq(conversations.id, conversationId));
		assert.equal(a.status, "active");

		const tasks = await db
			.select({ triggerMessageId: autonomousTasks.triggerMessageId })
			.from(autonomousTasks)
			.where(
				and(
					eq(autonomousTasks.conversationId, conversationId),
					eq(autonomousTasks.taskType, PROCESS_INBOUND_MESSAGE_TASK)
				)
			)
			.orderBy(asc(autonomousTasks.createdAt));
		assert.equal(tasks.length, 2);
		assert.equal(tasks[0].triggerMessageId, m1.id);
		assert.equal(tasks[1].triggerMessageId, m2.id);
	} finally {
		await cleanup(leadId);
	}
});

test("mensagem concorrente ao toque nova nunca deixa duas conversas ativas", async () => {
	const { conversationId, leadId } = await createFixture();

	try {
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

		// A concurrent inbound message is persisted in A while the `nova` tap
		// runs. The moved message must end up in the single active conversation.
		const [lateMessage] = await db
			.insert(messages)
			.values({ content: "mensagem tardia", conversationId, role: "user" })
			.returning({ id: messages.id });
		assert.ok(lateMessage);

		await tapChoice({
			buttonId: "sessao:nova",
			conversationId,
			externalId: `wamid.adv4_${Date.now()}`,
		});

		const convs = await db
			.select({ id: conversations.id, status: conversations.status })
			.from(conversations)
			.where(eq(conversations.leadId, leadId));
		const active = convs.filter((c) => c.status === "active");
		assert.equal(active.length, 1);

		const [moved] = await db
			.select({ conversationId: messages.conversationId })
			.from(messages)
			.where(eq(messages.id, lateMessage.id));
		assert.equal(moved.conversationId, active[0].id);
	} finally {
		await cleanup(leadId);
	}
});
