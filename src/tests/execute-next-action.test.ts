/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { executeNextAction } from "../services/agent/execute-next-action";

const INVALID_NEXT_ACTION_ERROR = /Unsupported next action: invalid_action/;

test("continue_qualification retorna status executed", async () => {
	const result = await executeNextAction({
		conversationId: "conv-1",
		currentMessages: ["Vamos continuar"],
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
		currentMessages: ["Quero agendar uma conversa"],
		currentStatus: "qualified",
		leadId: "lead-2",
		nextAction: "offer_meeting",
	});

	assert.deepEqual(result, {
		action: "offer_meeting",
		status: "executed",
	});
});

// Pedido explícito de consultor é intenção de agendamento (decisão 4).
test("pedido explícito de consultor vira oferta de horários para lead qualificado", async () => {
	for (const message of [
		"Quero falar com um consultor",
		"eu posso falar com o consultor?",
		"quero atendimento humano",
		"posso conversar com uma pessoa?",
		"quero marcar uma conversa",
		"quero ver os horários",
	]) {
		for (const nextAction of [
			"request_consultant",
			"continue_qualification",
		] as const) {
			const result = await executeNextAction({
				conversationId: "conv-consultant",
				currentMessages: [message],
				currentStatus: "qualified",
				leadId: "lead-consultant",
				nextAction,
			});

			assert.deepEqual(
				result,
				{ action: "offer_meeting", status: "executed" },
				`${message} / ${nextAction}`
			);
		}
	}
});

test("pedido de consultor negado não vira oferta", async () => {
	for (const message of [
		"não quero falar com consultor",
		"nao preciso falar com um consultor agora",
	]) {
		const result = await executeNextAction({
			conversationId: "conv-consultant-negated",
			currentMessages: [message],
			currentStatus: "qualified",
			leadId: "lead-consultant-negated",
			nextAction: "continue_qualification",
		});

		assert.deepEqual(
			result,
			{ action: "continue_qualification", status: "executed" },
			message
		);
	}
});

test("pergunta sensível sem pedido explícito continua handoff", async () => {
	const result = await executeNextAction({
		conversationId: "conv-sensitive",
		currentMessages: ["quanto fica a parcela?"],
		currentStatus: "qualified",
		leadId: "lead-sensitive",
		nextAction: "request_consultant",
	});

	assert.deepEqual(result, {
		action: "request_consultant",
		status: "executed",
	});
});

test("close continua close mesmo com pedido explícito", async () => {
	const result = await executeNextAction({
		conversationId: "conv-close-intent",
		currentMessages: ["quero falar com um consultor"],
		currentStatus: "qualified",
		leadId: "lead-close-intent",
		nextAction: "close",
		persistConversationStatus: async ({ conversationId }) => ({
			id: conversationId,
		}),
	});

	assert.deepEqual(result, { action: "close", status: "executed" });
});

test("schedule_meeting retorna status pending sem criar appointment", async () => {
	const result = await executeNextAction({
		conversationId: "conv-3",
		currentMessages: ["Quero agendar uma conversa"],
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
		currentMessages: ["Encerrar"],
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
				currentMessages: ["Olá"],
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
			currentMessages: ["Quero agendar uma conversa"],
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

test("schedule_meeting continua bloqueado para lead não qualificado", async () => {
	const result = await executeNextAction({
		conversationId: "conv-schedule-unqualified",
		currentMessages: ["Quero agendar uma conversa"],
		currentStatus: "qualifying",
		leadId: "lead-schedule-unqualified",
		nextAction: "schedule_meeting",
	});

	assert.deepEqual(result, {
		action: "continue_qualification",
		status: "executed",
	});
});

test("greeting não autoriza oferta para lead qualificado ou em qualificação", async () => {
	for (const currentStatus of ["qualified", "qualifying"]) {
		const result = await executeNextAction({
			conversationId: `conv-greeting-${currentStatus}`,
			currentMessages: ["Olá, Mariana. Boa tarde"],
			currentStatus,
			leadId: `lead-greeting-${currentStatus}`,
			nextAction: "offer_meeting",
		});

		assert.deepEqual(result, {
			action: "continue_qualification",
			status: "executed",
		});
	}
});

test("pedido de agendamento atual autoriza oferta quando lead está qualificado", async () => {
	const result = await executeNextAction({
		conversationId: "conv-explicit-request",
		currentMessages: ["Quero agendar uma conversa"],
		currentStatus: "qualified",
		leadId: "lead-explicit-request",
		nextAction: "offer_appointment",
	});

	assert.deepEqual(result, { action: "offer_meeting", status: "executed" });
});

test("pergunta por horários disponíveis autoriza agendamento", async () => {
	const result = await executeNextAction({
		conversationId: "conv-availability-request",
		currentMessages: ["Quais horários estão disponíveis?"],
		currentStatus: "qualified",
		leadId: "lead-availability-request",
		nextAction: "schedule_meeting",
	});

	assert.deepEqual(result, { action: "schedule_meeting", status: "pending" });
});

test("pedido histórico de agendamento não autoriza greeting atual", async () => {
	const result = await executeNextAction({
		conversationId: "conv-historical-request",
		currentMessages: ["Olá, Mariana"],
		currentStatus: "qualified",
		leadId: "lead-historical-request",
		nextAction: "schedule_meeting",
	});

	assert.deepEqual(result, {
		action: "continue_qualification",
		status: "executed",
	});
});

test("solicitação negada e pergunta comercial não autorizam agendamento", async () => {
	for (const currentMessages of [
		["Não quero agendar uma conversa"],
		["Qual é a taxa exata?"],
		["Pode me passar o horário de funcionamento?"],
	]) {
		const result = await executeNextAction({
			conversationId: "conv-non-scheduling",
			currentMessages,
			currentStatus: "qualified",
			leadId: "lead-non-scheduling",
			nextAction: "schedule_meeting",
		});

		assert.deepEqual(result, {
			action: "continue_qualification",
			status: "executed",
		});
	}
});

test("aceite de oferta pendente autoriza offer_meeting para lead qualificado", async () => {
	const result = await executeNextAction({
		acceptedPendingOffer: true,
		conversationId: "conv-accepted-offer",
		currentMessages: ["sim eu quero"],
		currentStatus: "qualified",
		leadId: "lead-accepted-offer",
		nextAction: "offer_meeting",
	});

	assert.deepEqual(result, { action: "offer_meeting", status: "executed" });
});

test("afirmativa sem oferta pendente não autoriza offer_meeting", async () => {
	const result = await executeNextAction({
		conversationId: "conv-bare-yes",
		currentMessages: ["sim eu quero"],
		currentStatus: "qualified",
		leadId: "lead-bare-yes",
		nextAction: "offer_meeting",
	});

	assert.deepEqual(result, {
		action: "continue_qualification",
		status: "executed",
	});
});

test("aceite de oferta pendente após request_consultant segue para offer_meeting", async () => {
	const result = await executeNextAction({
		acceptedPendingOffer: true,
		conversationId: "conv-accepted-handoff",
		currentMessages: ["sim porfavor"],
		currentStatus: "qualified",
		leadId: "lead-accepted-handoff",
		nextAction: "request_consultant",
	});

	assert.deepEqual(result, { action: "offer_meeting", status: "executed" });
});

test("aceite de oferta pendente com lead não qualificado continua a qualificação", async () => {
	const result = await executeNextAction({
		acceptedPendingOffer: true,
		conversationId: "conv-accepted-unqualified",
		currentMessages: ["sim"],
		currentStatus: "qualifying",
		leadId: "lead-accepted-unqualified",
		nextAction: "offer_meeting",
	});

	assert.deepEqual(result, {
		action: "continue_qualification",
		status: "executed",
	});
});
