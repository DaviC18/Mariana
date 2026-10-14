import assert from "node:assert/strict";
import test from "node:test";

import {
	buildInboundReplyIdempotencyKey,
	type InboundBatchCandidate,
	type InboundBatchTask,
	selectInboundMessageBatch,
} from "../services/conversations/inbound-message-batch";

const batchCutoffAt = "2026-10-14T12:00:15.000Z";
const anchorTask: InboundBatchTask = {
	createdAt: new Date("2026-10-14T12:00:00.000Z"),
	id: "task-current",
	payload: { batchCutoffAt },
	triggerMessageId: "message-current",
};

function candidate({
	content,
	createdAt,
	id,
	taskCreatedAt,
	taskId,
	taskPayload = { batchCutoffAt },
}: {
	content: string;
	createdAt: string;
	id: string;
	taskCreatedAt: string;
	taskId: string;
	taskPayload?: Record<string, unknown>;
}): InboundBatchCandidate {
	return {
		content,
		createdAt: new Date(createdAt),
		id,
		taskCreatedAt: new Date(taskCreatedAt),
		taskId,
		taskPayload,
	};
}

test("greeting batch excludes stale history outside the durable batch", () => {
	const selected = selectInboundMessageBatch({
		anchorTask,
		candidates: [
			candidate({
				content: "Pergunta antiga sem batch atual",
				createdAt: "2026-10-14T11:30:00.000Z",
				id: "message-old",
				taskCreatedAt: "2026-10-14T11:30:00.000Z",
				taskId: "task-old",
				taskPayload: { batchCutoffAt },
			}),
			candidate({
				content: "Olá, Mariana",
				createdAt: "2026-10-14T12:00:00.000Z",
				id: "message-current",
				taskCreatedAt: "2026-10-14T12:00:00.001Z",
				taskId: "task-current",
			}),
		],
	});

	assert.deepEqual(
		selected.map((message) => message.id),
		["message-current"]
	);
});

test("multiple pending messages in one debounce batch remain ordered", () => {
	const selected = selectInboundMessageBatch({
		anchorTask,
		candidates: [
			candidate({
				content: "Segunda parte",
				createdAt: "2026-10-14T12:00:05.000Z",
				id: "message-second",
				taskCreatedAt: "2026-10-14T12:00:05.001Z",
				taskId: "task-second",
			}),
			candidate({
				content: "Primeira parte",
				createdAt: "2026-10-14T12:00:00.000Z",
				id: "message-current",
				taskCreatedAt: "2026-10-14T12:00:00.001Z",
				taskId: "task-current",
			}),
		],
	});

	assert.deepEqual(
		selected.map((message) => message.id),
		["message-current", "message-second"]
	);
});

test("retry reuses the same batch boundary and reply idempotency key", () => {
	const laterCandidate = candidate({
		content: "Mensagem recebida depois do cutoff",
		createdAt: "2026-10-14T12:00:16.000Z",
		id: "message-later",
		taskCreatedAt: "2026-10-14T12:00:16.001Z",
		taskId: "task-later",
		taskPayload: { batchCutoffAt: "2026-10-14T12:00:31.001Z" },
	});
	const candidates = [
		candidate({
			content: "Olá",
			createdAt: "2026-10-14T12:00:00.000Z",
			id: "message-current",
			taskCreatedAt: "2026-10-14T12:00:00.001Z",
			taskId: "task-current",
		}),
		laterCandidate,
	];
	const firstAttempt = selectInboundMessageBatch({ anchorTask, candidates });
	const retry = selectInboundMessageBatch({ anchorTask, candidates });
	const duplicateDeliveryTask = {
		...anchorTask,
		id: "replayed-task",
	};

	assert.deepEqual(retry, firstAttempt);
	assert.deepEqual(
		retry.map((message) => message.id),
		["message-current"]
	);
	assert.equal(
		buildInboundReplyIdempotencyKey("conversation-1", "message-current"),
		buildInboundReplyIdempotencyKey(
			"conversation-1",
			duplicateDeliveryTask.triggerMessageId ?? ""
		)
	);
});
