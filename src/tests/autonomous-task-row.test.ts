import assert from "node:assert/strict";
import test from "node:test";

import { mapAutonomousTaskRow } from "../services/conversations/autonomous-task-row";

// Forma de uma linha crua de `db.execute(... RETURNING task.*)` com o driver
// postgres-js do drizzle: timestamptz como string.
const rawRow = {
	attempts: 1,
	availableAt: "2026-10-14 22:13:26.527+00",
	completedAt: null,
	conversationId: "7c251635-98c3-43f5-9afa-d0a57afaf808",
	createdAt: "2026-10-14 22:13:01.939123+00",
	id: "task-1",
	idempotencyKey: "inbound:task-1",
	lastError: null,
	leaseExpiresAt: "2026-10-14 22:14:27.202+00",
	leaseToken: "lease-1",
	lockedAt: "2026-10-14 22:13:27.202+00",
	maxAttempts: 5,
	maxSteps: 8,
	payload: { batchCutoffAt: "2026-10-14T22:13:26.527Z" },
	result: null,
	startedAt: "2026-10-14 22:13:27.202+00",
	status: "processing",
	stepNumber: 0,
	taskType: "process_inbound_message",
	triggerMessageId: "message-1",
	updatedAt: "2026-10-14 22:13:27.202+00",
	workflowId: "workflow-1",
};

test("mapAutonomousTaskRow converte timestamps em Date", () => {
	const task = mapAutonomousTaskRow(rawRow);

	assert.ok(task.createdAt instanceof Date);
	assert.equal(task.createdAt.toISOString(), "2026-10-14T22:13:01.939Z");
	assert.ok(task.availableAt instanceof Date);
	assert.ok(task.leaseExpiresAt instanceof Date);
	assert.ok(task.lockedAt instanceof Date);
	assert.ok(task.startedAt instanceof Date);
	assert.ok(task.updatedAt instanceof Date);
	assert.equal(task.completedAt, null);
	assert.equal(task.leaseToken, "lease-1");
	assert.equal(task.attempts, 1);
});

test("mapAutonomousTaskRow mantém payload objeto e parseia jsonb em texto", () => {
	assert.deepEqual(mapAutonomousTaskRow(rawRow).payload, rawRow.payload);

	const textPayload = mapAutonomousTaskRow({
		...rawRow,
		payload: JSON.stringify(rawRow.payload),
		result: '{"ok":true}',
	});
	assert.deepEqual(textPayload.payload, rawRow.payload);
	assert.deepEqual(textPayload.result, { ok: true });
});

test("mapAutonomousTaskRow aceita Date já tipado e rejeita timestamp inválido", () => {
	const createdAt = new Date("2026-10-14T22:13:01.939Z");
	assert.equal(
		mapAutonomousTaskRow({ ...rawRow, createdAt }).createdAt,
		createdAt
	);
	assert.throws(
		() => mapAutonomousTaskRow({ ...rawRow, createdAt: "not-a-date" }),
		TypeError
	);
});
