/** biome-ignore-all lint/performance/noAwaitInLoops: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { COMMERCIAL_HANDOFF } from "../../ai/knowledge/commercial-policy";
import { executeNextAction } from "../../services/agent/execute-next-action";
import {
	persistAuthorizedAssistantReply,
	runSchedulingOfferIfAuthorized,
} from "../../services/conversations/generateMarianaResponse";

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
