/** biome-ignore-all lint/performance/useTopLevelRegex: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { buildConversationContextSection } from "../ai/agent";
import { CONSULTANT_OFFER_TEXT } from "../ai/knowledge/commercial-policy";
import { buildMarianaSystemPrompt } from "../ai/prompt";

test("primeiro contato permite cumprimento e informa etapa e pergunta da aplicação", () => {
	const section = buildConversationContextSection({
		doNotAsk: ["nome: Davi"],
		isFirstContact: true,
		pendingOffer: null,
		question: "Como posso te chamar?",
		stage: "greeting",
	});

	assert.match(section, /# CONTEXTO DA CONVERSA/);
	assert.match(section, /Etapa atual: greeting/);
	assert.match(section, /cumprimente o cliente uma única vez/);
	assert.match(section, /exatamente esta pergunta: "Como posso te chamar\?"/);
	assert.match(section, /Não escreva nenhuma pergunta/);
	assert.match(section, /Nunca pergunte de novo:\n- nome: Davi/);
	assert.match(section, /"carro"/);
	assert.match(section, /tenho um carro usado e quero um novo/);
	assert.match(section, /já disse isso/);
});

test("conversa em andamento proíbe novo cumprimento", () => {
	const section = buildConversationContextSection({
		doNotAsk: [],
		isFirstContact: false,
		pendingOffer: null,
		question: null,
		stage: "info",
	});

	assert.match(section, /NÃO cumprimente novamente/);
	assert.doesNotMatch(section, /cumprimente o cliente uma única vez/);
	assert.match(section, /Não há pergunta da aplicação neste turno/);
});

test("oferta pendente é informada ao modelo", () => {
	const section = buildConversationContextSection({
		doNotAsk: [],
		isFirstContact: false,
		pendingOffer: "consultant_meeting",
		question: null,
		stage: "scheduling",
	});

	assert.match(section, /ofereceu procurar um horário/);
	assert.match(section, /não invente horários/);
});

test("prompt base traz o fluxo objetivo como prioridade 4", () => {
	const prompt = buildMarianaSystemPrompt();

	assert.match(
		prompt,
		/3\. Regras de negócio\.\n4\. Fluxo objetivo de atendimento/
	);
	assert.match(
		prompt,
		/# FLUXO OBJETIVO DE ATENDIMENTO \(prioridade 4 — abaixo apenas de Segurança, Precisão e Regras de negócio\)/
	);
	assert.match(
		prompt,
		/Situação atual e motivação são opcionais: pergunte no máximo uma vez cada/
	);
	assert.match(prompt, /somente na primeira resposta da conversa/);
	assert.doesNotMatch(prompt, /Não ofereça reunião enquanto o lead estiver/);
	assert.doesNotMatch(prompt, /new` ou `qualifying/);
	assert.ok(!prompt.includes(CONSULTANT_OFFER_TEXT));
});
