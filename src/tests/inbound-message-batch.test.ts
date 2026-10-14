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

// Reproduz a divisão observada em produção (conversa 7c251635-...): as duas
// tarefas tinham o mesmo `batchCutoffAt` e a âncora foi reivindicada depois da
// extensão, mas a mensagem seguinte foi respondida separadamente. Causa: o
// claim usa `db.execute(... RETURNING task.*)` e o driver postgres-js do
// drizzle devolve `timestamptz` como string. A comparação `Date >= string`
// vira `number >= NaN`, sempre `false`, e toda tarefa não-âncora é descartada.
test("âncora com createdAt em string do Postgres ainda agrega a mensagem seguinte", () => {
	const sharedCutoffAt = "2026-10-14T22:13:26.527Z";
	const rawRowAnchor = {
		...anchorTask,
		createdAt: "2026-10-14 22:13:01.939123+00",
		payload: { batchCutoffAt: sharedCutoffAt },
	} as unknown as InboundBatchTask;

	const selected = selectInboundMessageBatch({
		anchorTask: rawRowAnchor,
		candidates: [
			candidate({
				content: "ola Mariana boa noite",
				createdAt: "2026-10-14T22:13:01.900Z",
				id: "message-current",
				taskCreatedAt: "2026-10-14T22:13:01.939Z",
				taskId: "task-current",
				taskPayload: { batchCutoffAt: sharedCutoffAt },
			}),
			candidate({
				content: "Meu nome é Davi e eu quero fazer um consorcio",
				createdAt: "2026-10-14T22:13:11.580Z",
				id: "message-second",
				taskCreatedAt: "2026-10-14T22:13:11.604Z",
				taskId: "task-second",
				taskPayload: { batchCutoffAt: sharedCutoffAt },
			}),
		],
	});

	assert.deepEqual(
		selected.map((message) => message.id),
		["message-current", "message-second"]
	);
});

test("tarefa com cutoff diferente do da âncora não entra no batch", () => {
	const selected = selectInboundMessageBatch({
		anchorTask: {
			...anchorTask,
			payload: { batchCutoffAt: "2026-10-14T12:00:15.000Z" },
		},
		candidates: [
			candidate({
				content: "ola Mariana boa noite",
				createdAt: "2026-10-14T12:00:00.000Z",
				id: "message-current",
				taskCreatedAt: "2026-10-14T12:00:00.001Z",
				taskId: "task-current",
				taskPayload: { batchCutoffAt: "2026-10-14T12:00:15.000Z" },
			}),
			candidate({
				content: "Meu nome é Davi e eu quero fazer um consorcio",
				createdAt: "2026-10-14T12:00:10.000Z",
				id: "message-second",
				taskCreatedAt: "2026-10-14T12:00:10.001Z",
				taskId: "task-second",
				taskPayload: { batchCutoffAt: "2026-10-14T12:00:25.000Z" },
			}),
		],
	});

	assert.deepEqual(
		selected.map((message) => message.id),
		["message-current"]
	);
});

test("batch estendido a tempo agrega as duas mensagens com o mesmo cutoff", () => {
	const extendedCutoffAt = "2026-10-14T12:00:25.000Z";
	const extendedAnchor: InboundBatchTask = {
		...anchorTask,
		payload: { batchCutoffAt: extendedCutoffAt },
	};

	const selected = selectInboundMessageBatch({
		anchorTask: extendedAnchor,
		candidates: [
			candidate({
				content: "ola Mariana boa noite",
				createdAt: "2026-10-14T12:00:00.000Z",
				id: "message-current",
				taskCreatedAt: "2026-10-14T12:00:00.001Z",
				taskId: "task-current",
				taskPayload: { batchCutoffAt: extendedCutoffAt },
			}),
			candidate({
				content: "Meu nome é Davi e eu quero fazer um consorcio",
				createdAt: "2026-10-14T12:00:10.000Z",
				id: "message-second",
				taskCreatedAt: "2026-10-14T12:00:10.001Z",
				taskId: "task-second",
				taskPayload: { batchCutoffAt: extendedCutoffAt },
			}),
		],
	});

	assert.deepEqual(
		selected.map((message) => message.id),
		["message-current", "message-second"]
	);
});
