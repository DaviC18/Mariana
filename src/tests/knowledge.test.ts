/** biome-ignore-all lint/performance/useTopLevelRegex: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { MARIANA_KNOWLEDGE } from "../ai/knowledge";
import {
	formatKnowledgeContext,
	requiresSpecificCommercialEvidence,
	retrieveKnowledge,
} from "../ai/knowledge/retrieve";

const NO_EVIDENCE_PATTERN = /Nenhuma evidência autorizada/;

test("item autorizado é recuperado com categoria e fonte", () => {
	const result = retrieveKnowledge({
		items: MARIANA_KNOWLEDGE,
		query: "Qual é a idade mínima para contratação?",
	});

	assert.equal(result.evidenceFound, true);
	assert.equal(result.items[0]?.id, "qualificacao-idade-minima");
	assert.equal(result.items[0]?.category, "qualification");
	assert.ok((result.items[0]?.source ?? "").length > 0);
});

test("itens institucionais da Ademicon só são recuperados quando a Ademicon for configurada", () => {
	const withoutConfig = retrieveKnowledge({
		items: MARIANA_KNOWLEDGE,
		query: "A Ademicon opera no modelo CaaS?",
	});
	assert.equal(withoutConfig.evidenceFound, false);

	const otherCompany = retrieveKnowledge({
		businessProfile: { companyName: "Outra Empresa" },
		items: MARIANA_KNOWLEDGE,
		query: "A Ademicon opera no modelo CaaS?",
	});
	assert.equal(otherCompany.evidenceFound, false);

	const withAdemicon = retrieveKnowledge({
		businessProfile: { companyName: "Ademicon" },
		items: MARIANA_KNOWLEDGE,
		query: "A Ademicon opera no modelo CaaS?",
	});
	assert.equal(withAdemicon.evidenceFound, true);
	assert.equal(withAdemicon.items[0]?.id, "ademicon-segmentos-e-caas");
	assert.match(withAdemicon.items[0]?.source ?? "", /Ademicon/);
});

test("itens internos nunca são recuperados para o cliente", () => {
	const result = retrieveKnowledge({
		items: MARIANA_KNOWLEDGE,
		query: "Qual estratégia personalizada devo usar?",
	});

	assert.equal(
		result.items.some(
			(item) => item.id.includes("interna") || item.id.includes("interno")
		),
		false
	);
	assert.equal(
		formatKnowledgeContext(result).includes("politica-interna"),
		false
	);
});

test("retrieval retorna evidência para intenção geral de imóvel", () => {
	const result = retrieveKnowledge({
		items: MARIANA_KNOWLEDGE,
		query: "Quero comprar um imóvel.",
	});

	assert.equal(result.evidenceFound, true);
	assert.equal(
		result.items.some((item) => item.id === "produto-imobiliario-finalidades"),
		true
	);
});

test("perguntas específicas sem item específico retornam ausência de evidência", () => {
	for (const query of [
		"Qual grupo é melhor para mim?",
		"Qual lance preciso dar?",
		"Quanto tempo vou levar para ser contemplado?",
		"Consórcio dá lucro?",
	]) {
		const result = retrieveKnowledge({ items: MARIANA_KNOWLEDGE, query });
		assert.equal(requiresSpecificCommercialEvidence(query), true);
		assert.equal(result.evidenceFound, false, query);
		assert.equal(result.items.length, 0, query);
	}
});

test("contexto sem evidência instrui o fallback", () => {
	const result = retrieveKnowledge({
		items: MARIANA_KNOWLEDGE,
		query: "Qual grupo é melhor para mim?",
	});

	assert.match(formatKnowledgeContext(result), NO_EVIDENCE_PATTERN);
});
