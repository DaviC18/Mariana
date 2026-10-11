import assert from "node:assert/strict";
import test from "node:test";

import { MARIANA_KNOWLEDGE } from "../ai/knowledge";
import { retrieveKnowledge } from "../ai/knowledge/retrieve";
import {
	CONSULTANT_FALLBACK,
	validateMarianaEvidence,
} from "../ai/knowledge/validate-response";
import { marianaResponseSchema } from "../ai/schemas/mariana-response-schema";

const baseResponse = {
	leadUpdate: { status: "qualifying" as const },
	nextAction: "continue_qualification" as const,
	reply: "O consórcio pode ser usado para comprar um imóvel.",
};

test("resposta com evidência autorizada pode ser mantida", () => {
	const retrieval = retrieveKnowledge({
		items: MARIANA_KNOWLEDGE,
		query: "Quero comprar um imóvel.",
	});
	const response = marianaResponseSchema.parse({
		...baseResponse,
		evidenceUsed: ["produto-imobiliario-finalidades"],
	});

	assert.equal(
		validateMarianaEvidence({
			query: "Quero comprar um imóvel.",
			response,
			retrieval,
		}).reply,
		baseResponse.reply
	);
});

test("ID de evidência inexistente é rejeitado", () => {
	const retrieval = retrieveKnowledge({
		items: MARIANA_KNOWLEDGE,
		query: "Quero comprar um imóvel.",
	});
	const response = marianaResponseSchema.parse({
		...baseResponse,
		evidenceUsed: ["id-inventado-pela-ia"],
	});

	assert.throws(() =>
		validateMarianaEvidence({
			query: "Quero comprar um imóvel.",
			response,
			retrieval,
		})
	);
});

test("perguntas específicas sem evidência são encaminhadas ao consultor", () => {
	for (const query of [
		"Qual grupo é melhor para mim?",
		"Qual lance preciso dar?",
		"Quanto tempo vou levar para ser contemplado?",
		"Consórcio dá lucro?",
	]) {
		const retrieval = retrieveKnowledge({ items: MARIANA_KNOWLEDGE, query });
		const response = marianaResponseSchema.parse({
			...baseResponse,
			reply:
				"Ele poderá analisar as médias de lances dos grupos e indicar a melhor opção.",
		});
		const validated = validateMarianaEvidence({ query, response, retrieval });

		assert.equal(validated.reply, CONSULTANT_FALLBACK, query);
		assert.equal(validated.nextAction, "request_consultant", query);
	}
});

test("afirmação de média de lances sem evidência não passa", () => {
	const query = "Qual grupo é melhor para mim?";
	const retrieval = retrieveKnowledge({ items: MARIANA_KNOWLEDGE, query });
	const response = marianaResponseSchema.parse({
		...baseResponse,
		reply: "As médias de lances dos grupos ajudam a escolher.",
	});
	const validated = validateMarianaEvidence({ query, response, retrieval });

	assert.equal(validated.reply, CONSULTANT_FALLBACK);
});
