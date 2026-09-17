import assert from "node:assert/strict";
import test from "node:test";

import {
	MessageDebounceCoordinator,
	type ProcessDebouncedMessagesInput,
} from "../services/conversations/message-debounce";

const createMessage = (id: string, content: string) => ({
	content,
	id,
	receivedAt: new Date(`2026-09-11T00:00:0${id}Z`),
});

async function flushTimers() {
	await Promise.resolve();
	await Promise.resolve();
}

test("nova mensagem inicia o timer e três mensagens formam um bloco ordenado", async (t) => {
	t.mock.timers.enable();
	const coordinator = new MessageDebounceCoordinator(15_000);
	const processed: ProcessDebouncedMessagesInput[] = [];

	coordinator.schedule({
		conversationId: "conversation-1",
		message: createMessage("1", "Quero um carro"),
		process: (input) => {
			processed.push(input);
			return Promise.resolve();
		},
	});
	t.mock.timers.tick(8000);
	coordinator.schedule({
		conversationId: "conversation-1",
		message: createMessage("2", "Tenho um carro usado"),
		process: (input) => {
			processed.push(input);
			return Promise.resolve();
		},
	});
	t.mock.timers.tick(4000);
	coordinator.schedule({
		conversationId: "conversation-1",
		message: createMessage("3", "Quero trocar esse ano"),
		process: (input) => {
			processed.push(input);
			return Promise.resolve();
		},
	});

	assert.equal(coordinator.hasPending("conversation-1"), true);
	t.mock.timers.tick(14_999);
	await flushTimers();
	assert.equal(processed.length, 0);

	t.mock.timers.tick(1);
	await flushTimers();

	assert.equal(processed.length, 1);
	assert.deepEqual(
		processed[0]?.messages.map((message) => message.content),
		["Quero um carro", "Tenho um carro usado", "Quero trocar esse ano"]
	);
	assert.deepEqual(
		processed[0]?.messages.map((message) => message.id),
		["1", "2", "3"]
	);
	t.mock.timers.reset();
});

test("mensagem durante processamento fica no próximo bloco", async (t) => {
	t.mock.timers.enable();
	const coordinator = new MessageDebounceCoordinator(15_000);
	const processed: string[][] = [];
	let releaseFirstProcessing: (() => void) | undefined;
	const firstProcessing = new Promise<void>((resolve) => {
		releaseFirstProcessing = resolve;
	});
	let processingCount = 0;
	const process = async ({ messages }: ProcessDebouncedMessagesInput) => {
		processingCount += 1;
		processed.push(messages.map((message) => message.content));
		if (processingCount === 1) {
			await firstProcessing;
		}
	};

	coordinator.schedule({
		conversationId: "conversation-2",
		message: createMessage("4", "Mensagem A"),
		process,
	});
	t.mock.timers.tick(15_000);
	await flushTimers();

	coordinator.schedule({
		conversationId: "conversation-2",
		message: createMessage("5", "Mensagem B"),
		process,
	});
	assert.equal(coordinator.hasPending("conversation-2"), true);

	releaseFirstProcessing?.();
	await flushTimers();
	assert.deepEqual(processed, [["Mensagem A"]]);

	t.mock.timers.tick(15_000);
	await flushTimers();
	assert.deepEqual(processed, [["Mensagem A"], ["Mensagem B"]]);
	t.mock.timers.reset();
});

test("mensagem duplicada não é processada duas vezes no mesmo bloco", async (t) => {
	t.mock.timers.enable();
	const coordinator = new MessageDebounceCoordinator(15_000);
	let processCount = 0;

	const process = () => {
		processCount += 1;
		return Promise.resolve();
	};
	const message = createMessage("6", "Mensagem única");

	coordinator.schedule({
		conversationId: "conversation-3",
		message,
		process,
	});
	coordinator.schedule({
		conversationId: "conversation-3",
		message,
		process,
	});
	t.mock.timers.tick(15_000);
	await flushTimers();

	assert.equal(processCount, 1);
	t.mock.timers.reset();
});

test("após processar um bloco, uma nova mensagem inicia outro turno", async (t) => {
	t.mock.timers.enable();
	const coordinator = new MessageDebounceCoordinator(15_000);
	let processCount = 0;

	const process = () => {
		processCount += 1;
		return Promise.resolve();
	};
	coordinator.schedule({
		conversationId: "conversation-4",
		message: createMessage("7", "Primeiro turno"),
		process,
	});
	t.mock.timers.tick(15_000);
	await flushTimers();
	assert.equal(processCount, 1);
	assert.equal(coordinator.hasPending("conversation-4"), false);

	coordinator.schedule({
		conversationId: "conversation-4",
		message: createMessage("8", "Segundo turno"),
		process,
	});
	t.mock.timers.tick(14_999);
	await flushTimers();
	assert.equal(processCount, 1);
	t.mock.timers.tick(1);
	await flushTimers();
	assert.equal(processCount, 2);
	t.mock.timers.reset();
});
