/** biome-ignore-all lint/performance/useTopLevelRegex: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { buildConversationContextSection } from "../ai/agent";
import { buildMarianaSystemPrompt } from "../ai/prompt";

test("primeiro contato permite cumprimento e lista pendências na ordem", () => {
	const section = buildConversationContextSection({
		isFirstContact: true,
		missingQualification: ["currentSituation", "painPoint"],
	});

	assert.match(section, /# CONTEXTO DA CONVERSA/);
	assert.match(section, /cumprimente o cliente uma única vez/);
	assert.ok(
		section.indexOf("1. situação atual") < section.indexOf("2. motivação")
	);
	assert.match(section, /Nunca use `offer_meeting`/);
	assert.match(section, /no máximo uma pergunta por mensagem/);
	assert.match(section, /"carro"/);
	assert.match(section, /o que você me indica\?/);
});

test("conversa em andamento proíbe novo cumprimento", () => {
	const section = buildConversationContextSection({
		isFirstContact: false,
		missingQualification: ["objective"],
	});

	assert.match(section, /NÃO cumprimente novamente/);
	assert.doesNotMatch(section, /cumprimente o cliente uma única vez/);
});

test("sem pendências não bloqueia ações de agendamento no contexto", () => {
	const section = buildConversationContextSection({
		isFirstContact: false,
		missingQualification: [],
	});

	assert.match(section, /já foram preenchidos/);
	assert.doesNotMatch(section, /Nunca use `offer_meeting`/);
});

test("prompt base limita o cumprimento à primeira resposta", () => {
	const prompt = buildMarianaSystemPrompt();

	assert.match(prompt, /somente na primeira resposta da conversa/);
	assert.match(
		prompt,
		/Nunca pergunte novamente uma informação que já foi dada no histórico da conversa/
	);
});
