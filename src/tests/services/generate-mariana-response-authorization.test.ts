/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { COMMERCIAL_HANDOFF } from "../../ai/knowledge/commercial-policy";
import { executeNextAction } from "../../services/agent/execute-next-action";
import {
	persistAuthorizedAssistantReply,
	runSchedulingOfferIfAuthorized,
} from "../../services/conversations/generateMarianaResponse";
import { buildQualificationFallbackReply } from "../../services/leads/qualification-gaps";

const SCHEDULING_COMMITMENT_PATTERN = /horários disponíveis|verificar/i;

test("oferta não autorizada é corrigida antes da persistência e não habilita slots", async () => {
	let availabilityCalls = 0;
	let offerPersistenceCalls = 0;
	let schedulingMessageCalls = 0;

	for (const nextAction of [
		"offer_meeting",
		"continue_qualification",
	] as const) {
		const actionResult = await executeNextAction({
			conversationId: `conv-unauthorized-${nextAction}`,
			currentMessages: ["Olá, Mariana"],
			currentStatus: "qualified",
			leadId: `lead-unauthorized-${nextAction}`,
			nextAction,
		});
		let persistedReply = "";

		const preparedReply = await persistAuthorizedAssistantReply({
			actionResult,
			persistAssistantMessage: (content) => {
				persistedReply = content;
				return Promise.resolve({ content });
			},
			reply:
				nextAction === "offer_meeting"
					? "Pode deixar, vamos resolver isso."
					: "Claro! Vou verificar os horários disponíveis para você.",
			requestedAction: nextAction,
		});

		await runSchedulingOfferIfAuthorized(preparedReply.shouldOfferSlots, () => {
			availabilityCalls += 1;
			offerPersistenceCalls += 1;
			schedulingMessageCalls += 1;
			return Promise.resolve();
		});

		assert.equal(preparedReply.actionResult.action, "continue_qualification");
		assert.equal(preparedReply.shouldOfferSlots, false);
		assert.equal(persistedReply, preparedReply.reply);
		assert.doesNotMatch(preparedReply.reply, SCHEDULING_COMMITMENT_PATTERN);
	}

	assert.equal(availabilityCalls, 0);
	assert.equal(offerPersistenceCalls, 0);
	assert.equal(schedulingMessageCalls, 0);
});

test("pedido atual autorizado mantém a oferta e a mensagem persistida acompanha o texto enviado", async () => {
	const actionResult = await executeNextAction({
		conversationId: "conv-authorized-offer",
		currentMessages: ["Quero agendar uma conversa"],
		currentStatus: "qualified",
		leadId: "lead-authorized-offer",
		nextAction: "offer_appointment",
	});
	const modelReply = "Vou verificar os horários disponíveis para você.";
	const preparedReply = await persistAuthorizedAssistantReply({
		actionResult,
		persistAssistantMessage: async (content) => ({ content }),
		reply: modelReply,
		requestedAction: "offer_appointment",
	});
	const textPayload = { kind: "text", text: preparedReply.reply } as const;

	assert.equal(preparedReply.actionResult.action, "offer_meeting");
	assert.equal(preparedReply.shouldOfferSlots, true);
	assert.equal(preparedReply.reply, modelReply);
	assert.equal(preparedReply.assistantMessage.content, textPayload.text);

	let schedulingStarted = 0;
	await runSchedulingOfferIfAuthorized(preparedReply.shouldOfferSlots, () => {
		schedulingStarted += 1;
		return Promise.resolve();
	});
	assert.equal(schedulingStarted, 1);
});

test("pedido de consultor permanece handoff e não é convertido em oferta de horários", async () => {
	const actionResult = await executeNextAction({
		conversationId: "conv-consultant-handoff",
		currentMessages: ["Qual é a taxa exata?"],
		currentStatus: "qualified",
		leadId: "lead-consultant-handoff",
		nextAction: "request_consultant",
	});
	const preparedReply = await persistAuthorizedAssistantReply({
		actionResult,
		persistAssistantMessage: async (content) => ({ content }),
		reply: "Posso encaminhar você e verificar os horários disponíveis.",
		requestedAction: "request_consultant",
	});

	assert.equal(preparedReply.actionResult.action, "request_consultant");
	assert.equal(preparedReply.shouldOfferSlots, false);
	assert.equal(preparedReply.reply, COMMERCIAL_HANDOFF);
	assert.equal(preparedReply.assistantMessage.content, COMMERCIAL_HANDOFF);
});

test("offer_meeting bloqueado em qualifying usa o fallbackReply de qualificação", async () => {
	const actionResult = await executeNextAction({
		conversationId: "conv-blocked-carro-novo",
		currentMessages: ["carro novo"],
		currentStatus: "qualifying",
		leadId: "lead-blocked-carro-novo",
		nextAction: "offer_meeting",
	});
	const fallbackReply =
		"Hoje, como está a sua situação em relação a esse objetivo?";
	let persistedReply = "";

	const preparedReply = await persistAuthorizedAssistantReply({
		actionResult,
		fallbackReply,
		persistAssistantMessage: (content) => {
			persistedReply = content;
			return Promise.resolve({ content });
		},
		reply: "Ótimo! Posso agendar uma conversa com um consultor para você.",
		requestedAction: "offer_meeting",
	});

	assert.equal(preparedReply.actionResult.action, "continue_qualification");
	assert.equal(preparedReply.shouldOfferSlots, false);
	assert.equal(preparedReply.reply, fallbackReply);
	assert.equal(persistedReply, fallbackReply);
});

test("bloqueio sem fallbackReply não usa a frase sem saída e termina com pergunta", async () => {
	const actionResult = await executeNextAction({
		conversationId: "conv-blocked-no-fallback",
		currentMessages: ["de um veiculo"],
		currentStatus: "qualifying",
		leadId: "lead-blocked-no-fallback",
		nextAction: "offer_meeting",
	});

	const preparedReply = await persistAuthorizedAssistantReply({
		actionResult,
		persistAssistantMessage: async (content) => ({ content }),
		reply: "Vou verificar os horários disponíveis para você.",
		requestedAction: "offer_meeting",
	});

	assert.notEqual(
		preparedReply.reply,
		"Posso ajudar com suas dúvidas e entender melhor o que você procura."
	);
	assert.ok(preparedReply.reply.trim().endsWith("?"));
	assert.doesNotMatch(preparedReply.reply, SCHEDULING_COMMITMENT_PATTERN);
	assert.equal(preparedReply.assistantMessage.content, preparedReply.reply);
});

test("fallbackReply não substitui o handoff de request_consultant", async () => {
	const actionResult = await executeNextAction({
		conversationId: "conv-handoff-with-fallback",
		currentMessages: ["Qual é a taxa exata?"],
		currentStatus: "qualifying",
		leadId: "lead-handoff-with-fallback",
		nextAction: "request_consultant",
	});

	const preparedReply = await persistAuthorizedAssistantReply({
		actionResult,
		fallbackReply: "Qual é o seu principal objetivo com o consórcio?",
		persistAssistantMessage: async (content) => ({ content }),
		reply: "Vou verificar os horários disponíveis para você.",
		requestedAction: "request_consultant",
	});

	assert.equal(preparedReply.reply, COMMERCIAL_HANDOFF);
});

test("resposta autorizada ignora fallbackReply", async () => {
	const actionResult = await executeNextAction({
		conversationId: "conv-allowed-with-fallback",
		currentMessages: ["carro novo"],
		currentStatus: "qualifying",
		leadId: "lead-allowed-with-fallback",
		nextAction: "continue_qualification",
	});
	const modelReply = "Entendi! Hoje você já tem algum carro?";

	const preparedReply = await persistAuthorizedAssistantReply({
		actionResult,
		fallbackReply: "Qual é o seu principal objetivo com o consórcio?",
		persistAssistantMessage: async (content) => ({ content }),
		reply: modelReply,
		requestedAction: "continue_qualification",
	});

	assert.equal(preparedReply.reply, modelReply);
});

test("pergunta de interesse no consultor não é tratada como compromisso de agendamento", async () => {
	const question = buildQualificationFallbackReply(["interestedInConsultant"]);
	const alternate = buildQualificationFallbackReply(
		["interestedInConsultant"],
		question
	);

	for (const reply of [question, alternate]) {
		const prepared = await persistAuthorizedAssistantReply({
			actionResult: { action: "continue_qualification", status: "executed" },
			fallbackReply: "fallback",
			persistAssistantMessage: async (content) => content,
			reply,
			requestedAction: "continue_qualification",
		});

		assert.equal(prepared.reply, reply);
	}
});
