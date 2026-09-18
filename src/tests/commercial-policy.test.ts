import assert from "node:assert/strict";
import test from "node:test";

import { MARIANA_KNOWLEDGE } from "../ai/knowledge";
import {
	type CommercialAccessResolution,
	resolveCommercialAccess,
} from "../ai/knowledge/commercial-policy";
import { retrieveKnowledge } from "../ai/knowledge/retrieve";
import {
	CONSULTANT_FALLBACK,
	validateMarianaEvidence,
} from "../ai/knowledge/validate-response";
import { marianaResponseSchema } from "../ai/schemas/mariana-response-schema";

const resolve = (message: string): CommercialAccessResolution =>
	resolveCommercialAccess({
		message,
		retrievedKnowledge: retrieveKnowledge({
			items: MARIANA_KNOWLEDGE,
			query: message,
		}),
	});

const baseResponse = {
	leadUpdate: { status: "qualifying" as const },
	nextAction: "continue_qualification" as const,
	reply: "O consórcio pode ser explicado de forma geral.",
};

test("nível 1 permite perguntas gerais", () => {
	for (const message of [
		"O que é consórcio?",
		"Qual a idade mínima?",
		"Quais bens posso adquirir?",
	]) {
		assert.equal(resolve(message).level, 1, message);
	}
});

test("nível 2 restringe conceitos comerciais sem bloquear a explicação", () => {
	for (const message of [
		"Como funciona o lance?",
		"Existe taxa de administração?",
		"Como funciona o sorteio?",
	]) {
		assert.equal(resolve(message).level, 2, message);
	}
});

test("nível 3 bloqueia decisões e informações comerciais específicas", () => {
	for (const message of [
		"Qual é a taxa exata?",
		"Quanto é a taxa de administração?",
		"Quanto vou pagar por mês em uma carta de 500 mil?",
		"Qual lance eu preciso dar?",
		"Qual grupo é melhor para mim?",
		"Qual carta é melhor para mim?",
		"Quanto tempo demora para eu ser contemplado?",
		"Consórcio dá lucro?",
		"Qual estratégia eu devo usar?",
		"A contemplação é garantida?",
	]) {
		assert.equal(resolve(message).level, 3, message);
	}
});

test("uma pergunta conceitual com detalhe específico sobe para nível 3", () => {
	assert.equal(resolve("Como funciona o lance de 30%?").level, 3);
	assert.equal(resolve("Como funciona o meu grupo específico?").level, 3);
});

test("resposta de nível 2 com detalhe comercial é substituída por handoff", () => {
	const query = "Como funciona o lance?";
	const retrieval = retrieveKnowledge({ items: MARIANA_KNOWLEDGE, query });
	const response = marianaResponseSchema.parse({
		...baseResponse,
		reply: "Um lance de 30% costuma ser uma boa estratégia.",
	});
	const validated = validateMarianaEvidence({
		commercialAccess: resolveCommercialAccess({
			message: query,
			retrievedKnowledge: retrieval,
		}),
		query,
		response,
		retrieval,
	});

	assert.equal(validated.reply, CONSULTANT_FALLBACK);
	assert.equal(validated.nextAction, "request_consultant");
});

test("explicação conceitual de taxa de administração pode permanecer", () => {
	const query = "Existe taxa de administração?";
	const retrieval = retrieveKnowledge({ items: MARIANA_KNOWLEDGE, query });
	const response = marianaResponseSchema.parse({
		...baseResponse,
		reply: "A taxa de administração é um custo previsto na gestão do grupo.",
	});
	const validated = validateMarianaEvidence({
		commercialAccess: resolveCommercialAccess({
			message: query,
			retrievedKnowledge: retrieval,
		}),
		query,
		response,
		retrieval,
	});

	assert.equal(validated.reply, response.reply);
});
