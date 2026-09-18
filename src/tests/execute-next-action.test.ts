/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { executeNextAction } from "../services/agent/execute-next-action";

const INVALID_NEXT_ACTION_ERROR = /Unsupported next action: invalid_action/;

test("continue_qualification retorna status executed", async () => {
	const result = await executeNextAction({
		conversationId: "conv-1",
		currentStatus: "qualifying",
		leadId: "lead-1",
		nextAction: "continue_qualification",
	});

	assert.deepEqual(result, {
		action: "continue_qualification",
		status: "executed",
	});
});

test("offer_meeting retorna status executed", async () => {
	const result = await executeNextAction({
		conversationId: "conv-2",
		currentStatus: "qualified",
		leadId: "lead-2",
		nextAction: "offer_meeting",
	});

	assert.deepEqual(result, {
		action: "offer_meeting",
		status: "executed",
	});
});

test("pedido direto de consultor segue para oferta de reunião", async () => {
	const result = await executeNextAction({
		conversationId: "conv-consultant",
		currentStatus: "qualified",
		leadId: "lead-consultant",
		nextAction: "request_consultant",
	});

	assert.deepEqual(result, {
		action: "offer_meeting",
		status: "executed",
	});
});

test("schedule_meeting retorna status pending sem criar appointment", async () => {
	const result = await executeNextAction({
		conversationId: "conv-3",
		currentStatus: "qualified",
		leadId: "lead-3",
		nextAction: "schedule_meeting",
	});

	assert.deepEqual(result, {
		action: "schedule_meeting",
		status: "pending",
	});
});

test("close atualiza a conversation para closed", async () => {
	let persisted: {
		conversationId: string;
		status: "closed";
		updatedAt: Date;
	} | null = null;

	const result = await executeNextAction({
		conversationId: "conv-4",
		currentStatus: "qualifying",
		leadId: "lead-4",
		nextAction: "close",
		persistConversationStatus: ({ conversationId, status, updatedAt }) => {
			persisted = { conversationId, status, updatedAt };
			return Promise.resolve({ id: conversationId });
		},
	});

	assert.deepEqual(result, {
		action: "close",
		status: "executed",
	});
	if (persisted === null) {
		throw new Error("Expected persisted conversation state to be set");
	}
	const persistedConversation = persisted as {
		conversationId: string;
		status: "closed";
		updatedAt: Date;
	};
	assert.equal(persistedConversation.conversationId, "conv-4");
	assert.equal(persistedConversation.status, "closed");
	assert.ok(persistedConversation.updatedAt instanceof Date);
});

test("nextAction inválido lança erro de domínio", async () => {
	await assert.rejects(
		async () =>
			executeNextAction({
				conversationId: "conv-5",
				currentStatus: "qualifying",
				leadId: "lead-5",
				nextAction: "invalid_action" as never,
			}),
		INVALID_NEXT_ACTION_ERROR
	);
});

test("offer_meeting é neutralizado para lead novo ou em qualificação", async () => {
	for (const currentStatus of ["new", "qualifying"]) {
		const result = await executeNextAction({
			conversationId: `conv-blocked-${currentStatus}`,
			currentStatus,
			leadId: `lead-blocked-${currentStatus}`,
			nextAction: "offer_meeting",
		});

		assert.deepEqual(result, {
			action: "continue_qualification",
			status: "executed",
		});
	}
});

test("offer_appointment e request_consultant seguem a mesma autorização", async () => {
	const blockedActions = await Promise.all(
		["offer_appointment", "request_consultant"].map((nextAction) =>
			executeNextAction({
				conversationId: `conv-${nextAction}`,
				currentStatus: "qualifying",
				leadId: `lead-${nextAction}`,
				nextAction: nextAction as "offer_appointment" | "request_consultant",
			})
		)
	);

	assert.deepEqual(blockedActions, [
		{ action: "continue_qualification", status: "executed" },
		{ action: "continue_qualification", status: "executed" },
	]);
});
