/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { eq } from "drizzle-orm";

import { closeDatabase, db } from "../../db/connections";
import { autonomousTasks } from "../../db/schema/autonomous-tasks";
import { conversations } from "../../db/schema/conversations";
import { leads } from "../../db/schema/leads";
import {
	type AutonomousTask,
	executeNextAutonomousTask,
	PermanentAutonomousTaskError,
	recoverStaleAutonomousTasks,
	renewTaskLease,
	runAutonomousTasksUntilIdle,
} from "../../services/conversations/autonomous-task-executor";

test.after(async () => {
	await closeDatabase();
});

async function createConversationFixture() {
	const [lead] = await db
		.insert(leads)
		.values({
			consortiumType: "geral",
			name: "Lead Teste Executor",
			objective: "Teste de executor de tarefas",
			phone: `551199${Date.now()}${Math.floor(Math.random() * 1000)}`,
			status: "qualified",
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
		.delete(autonomousTasks)
		.where(eq(autonomousTasks.conversationId, conversationId));
	await db.delete(conversations).where(eq(conversations.id, conversationId));
	await db.delete(leads).where(eq(leads.id, leadId));
}

function insertTask(
	conversationId: string,
	overrides: Partial<typeof autonomousTasks.$inferInsert> = {}
) {
	return db
		.insert(autonomousTasks)
		.values({
			conversationId,
			idempotencyKey: `executor:${conversationId}:${Math.random()}`,
			taskType: "test_task",
			...overrides,
		})
		.returning({
			id: autonomousTasks.id,
			leaseToken: autonomousTasks.leaseToken,
		});
}

test("conclui tarefa pendente e limpa o lease", async () => {
	const { conversationId, leadId } = await createConversationFixture();

	try {
		const [task] = await insertTask(conversationId);
		assert.ok(task);

		const result = await executeNextAutonomousTask({
			conversationId,
			handlers: {
				test_task: async ({ task: claimed, leaseToken }) => {
					assert.equal(claimed.id, task.id);
					assert.ok(leaseToken);
					return { done: true };
				},
			},
		});

		assert.equal(result.status, "completed");

		const [saved] = await db
			.select({
				attempts: autonomousTasks.attempts,
				leaseToken: autonomousTasks.leaseToken,
				result: autonomousTasks.result,
				status: autonomousTasks.status,
			})
			.from(autonomousTasks)
			.where(eq(autonomousTasks.id, task.id))
			.limit(1);

		assert.equal(saved?.status, "completed");
		assert.equal(saved?.attempts, 1);
		assert.equal(saved?.leaseToken, null);
		assert.deepEqual(saved?.result, { done: true });
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("reagenda com backoff quando o handler falha de forma retryável", async () => {
	const { conversationId, leadId } = await createConversationFixture();

	try {
		const [task] = await insertTask(conversationId, { maxAttempts: 5 });
		assert.ok(task);

		const result = await executeNextAutonomousTask({
			conversationId,
			handlers: {
				test_task: async () => {
					throw new Error("falha transitória");
				},
			},
		});

		assert.equal(result.status, "retry_scheduled");

		const [saved] = await db
			.select({
				availableAt: autonomousTasks.availableAt,
				lastError: autonomousTasks.lastError,
				status: autonomousTasks.status,
			})
			.from(autonomousTasks)
			.where(eq(autonomousTasks.id, task.id))
			.limit(1);

		assert.equal(saved?.status, "pending");
		assert.equal(saved?.lastError, "falha transitória");
		assert.ok(saved && saved.availableAt.getTime() > Date.now() - 1000);
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("falha em definitivo quando o handler lança erro permanente", async () => {
	const { conversationId, leadId } = await createConversationFixture();

	try {
		const [task] = await insertTask(conversationId, { maxAttempts: 5 });
		assert.ok(task);

		const result = await executeNextAutonomousTask({
			conversationId,
			handlers: {
				test_task: async () => {
					throw new PermanentAutonomousTaskError("não pode ser repetido");
				},
			},
		});

		assert.equal(result.status, "failed");

		const [saved] = await db
			.select({ status: autonomousTasks.status })
			.from(autonomousTasks)
			.where(eq(autonomousTasks.id, task.id))
			.limit(1);

		assert.equal(saved?.status, "failed");
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("detecta perda de lease quando outro worker assume a tarefa", async () => {
	const { conversationId, leadId } = await createConversationFixture();

	try {
		const [task] = await insertTask(conversationId);
		assert.ok(task);

		const result = await executeNextAutonomousTask({
			conversationId,
			handlers: {
				test_task: async () => {
					await db
						.update(autonomousTasks)
						.set({ leaseToken: "00000000-0000-4000-8000-000000000000" })
						.where(eq(autonomousTasks.id, task.id));

					return { done: true };
				},
			},
		});

		assert.equal(result.status, "lease_lost");

		const [saved] = await db
			.select({ status: autonomousTasks.status })
			.from(autonomousTasks)
			.where(eq(autonomousTasks.id, task.id))
			.limit(1);

		assert.equal(saved?.status, "processing");
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("renewTaskLease falha com token que não é o dono", async () => {
	const { conversationId, leadId } = await createConversationFixture();

	try {
		const [task] = await insertTask(conversationId);
		assert.ok(task);

		await executeNextAutonomousTask({
			conversationId,
			handlers: {
				test_task: async ({ leaseToken, task: claimed }) => {
					assert.equal(
						await renewTaskLease({
							leaseToken,
							taskId: claimed.id,
						}),
						true
					);
					assert.equal(
						await renewTaskLease({
							leaseToken: "00000000-0000-4000-8000-000000000001",
							taskId: claimed.id,
						}),
						false
					);
					return {};
				},
			},
		});
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("recupera tarefas com lease expirado e marca como falha quando esgota tentativas", async () => {
	const { conversationId, leadId } = await createConversationFixture();

	try {
		const expired = new Date(Date.now() - 60_000);

		const [recoverable] = await insertTask(conversationId, {
			attempts: 1,
			leaseExpiresAt: expired,
			leaseToken: "00000000-0000-4000-8000-000000000002",
			maxAttempts: 5,
			status: "processing",
		});
		const [exhausted] = await insertTask(conversationId, {
			attempts: 5,
			leaseExpiresAt: expired,
			leaseToken: "00000000-0000-4000-8000-000000000003",
			maxAttempts: 5,
			status: "processing",
		});
		assert.ok(recoverable);
		assert.ok(exhausted);

		const result = await recoverStaleAutonomousTasks();

		assert.ok(result.recovered >= 1);
		assert.ok(result.failed >= 1);

		const rows = await db
			.select({ id: autonomousTasks.id, status: autonomousTasks.status })
			.from(autonomousTasks)
			.where(eq(autonomousTasks.conversationId, conversationId));

		const byId = new Map(rows.map((row) => [row.id, row.status]));
		assert.equal(byId.get(recoverable.id), "pending");
		assert.equal(byId.get(exhausted.id), "failed");
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("runAutonomousTasksUntilIdle processa tarefas da conversa em ordem", async () => {
	const { conversationId, leadId } = await createConversationFixture();

	try {
		const order: string[] = [];
		const base = Date.now() - 10_000;

		await insertTask(conversationId, {
			availableAt: new Date(base),
			createdAt: new Date(base),
			payload: { label: "primeira" },
		});
		await insertTask(conversationId, {
			availableAt: new Date(base + 1000),
			createdAt: new Date(base + 1000),
			payload: { label: "segunda" },
		});

		const processed = await runAutonomousTasksUntilIdle({
			conversationId,
			handlers: {
				test_task: async ({ task }) => {
					order.push(String(task.payload.label));
					return {};
				},
			},
		});

		assert.equal(processed, 2);
		assert.deepEqual(order, ["primeira", "segunda"]);
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("tarefa mais nova não ultrapassa tarefa antiga em backoff", async () => {
	const { conversationId, leadId } = await createConversationFixture();

	try {
		const now = Date.now();
		const [olderTask] = await insertTask(conversationId, {
			availableAt: new Date(now + 60_000),
			createdAt: new Date(now - 2000),
			payload: { label: "older" },
		});
		await insertTask(conversationId, {
			availableAt: new Date(now - 1000),
			createdAt: new Date(now - 1000),
			payload: { label: "newer" },
		});
		assert.ok(olderTask);

		const handlers = {
			test_task: async () => ({}),
		};
		const result = await executeNextAutonomousTask({
			conversationId,
			handlers,
		});
		assert.deepEqual(result, { status: "idle" });

		await db
			.update(autonomousTasks)
			.set({ availableAt: new Date(now - 1000) })
			.where(eq(autonomousTasks.id, olderTask.id));

		const order: string[] = [];
		await runAutonomousTasksUntilIdle({
			conversationId,
			handlers: {
				test_task: async ({ task }) => {
					order.push(String(task.payload.label));
					return {};
				},
			},
		});
		assert.deepEqual(order, ["older", "newer"]);
	} finally {
		await cleanup(leadId, conversationId);
	}
});

test("workers concorrentes não executam duas tarefas da mesma conversa em paralelo", async () => {
	const { conversationId, leadId } = await createConversationFixture();

	try {
		const base = Date.now() - 5000;
		await insertTask(conversationId, {
			availableAt: new Date(base),
			createdAt: new Date(base),
			payload: { label: "primeira" },
		});
		await insertTask(conversationId, {
			availableAt: new Date(base + 1000),
			createdAt: new Date(base + 1000),
			payload: { label: "segunda" },
		});

		let activeHandlers = 0;
		let maximumActiveHandlers = 0;
		const order: string[] = [];
		const handlers = {
			test_task: async ({ task }: { task: AutonomousTask }) => {
				activeHandlers += 1;
				maximumActiveHandlers = Math.max(maximumActiveHandlers, activeHandlers);
				await new Promise((resolve) => setTimeout(resolve, 20));
				order.push(String(task.payload.label));
				activeHandlers -= 1;
				return {};
			},
		};

		await Promise.all([
			executeNextAutonomousTask({ conversationId, handlers }),
			executeNextAutonomousTask({ conversationId, handlers }),
		]);
		await runAutonomousTasksUntilIdle({ conversationId, handlers });

		assert.equal(maximumActiveHandlers, 1);
		assert.deepEqual(order, ["primeira", "segunda"]);
	} finally {
		await cleanup(leadId, conversationId);
	}
});
