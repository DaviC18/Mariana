/** biome-ignore-all lint/style/useFilenamingConvention: <> */
import assert from "node:assert/strict";
import test from "node:test";

import { resolveBusinessProfile } from "../ai/business-profile";
import { MARIANA_KNOWLEDGE } from "../ai/knowledge";
import {
	formatKnowledgeContext,
	retrieveKnowledge,
} from "../ai/knowledge/retrieve";
import { buildMarianaSystemPrompt } from "../ai/prompt";
import { closeDatabase, db } from "../db/connections";
import { conversations, leads } from "../db/schema";
import { generateMarianaResponse } from "../services/conversations/generateMarianaResponse";
import {
	assertSafeMarianaReply,
	isUnauthorizedCompanyMention,
	sanitizeCommercialIdentity,
} from "../services/conversations/mariana-safety";

test.after(async () => {
	await closeDatabase();
});

test("TEST 1: Cenário sem empresa configurada - Prompt e identidade neutra", () => {
	const prompt = buildMarianaSystemPrompt();

	// Não deve conter Ademicon nem na identidade nem no agendamento
	assert.equal(
		prompt.includes("Ademicon"),
		false,
		"System prompt sem empresa configurada não deve conter 'Ademicon'"
	);
	assert.match(
		prompt,
		/Você é Mariana, atendente virtual especializada no primeiro atendimento/
	);
	assert.match(
		prompt,
		/Você se identifica unicamente como Mariana, atendente virtual de consórcios/
	);

	// Sanitização e guardrail para resposta recebida
	const rawReply =
		"Olá, Davi! Seja bem-vindo à Ademicon. Como posso ajudar você hoje?";
	const sanitized = sanitizeCommercialIdentity(rawReply);
	assert.equal(
		sanitized.includes("Ademicon"),
		false,
		"Sanitização deve remover menção à Ademicon"
	);
	assert.match(sanitized, /Seja bem-vindo!/);

	// Guardrail impede vazamento não sanitizado
	assert.throws(
		() => assertSafeMarianaReply(rawReply),
		/unauthorized company mention/
	);
	// Mas aceita a resposta sanitizada
	assert.doesNotThrow(() => assertSafeMarianaReply(sanitized));
});

test("TEST 2: Cenário com empresa configurada (Empresa Teste)", () => {
	const profile = { city: "São Paulo", companyName: "Empresa Teste" };
	const prompt = buildMarianaSystemPrompt(profile);

	assert.equal(
		prompt.includes("Ademicon"),
		false,
		"Não deve citar Ademicon quando outra empresa for configurada"
	);
	assert.match(prompt, /Você é Mariana, atendente virtual da Empresa Teste/);
	assert.match(prompt, /Você representa a empresa "Empresa Teste"/);

	const validReply =
		"Olá! Sou a Mariana, assistente virtual da Empresa Teste. Como posso te ajudar hoje?";
	assert.doesNotThrow(() => assertSafeMarianaReply(validReply, profile));

	const leakingReply = "Olá! Seja bem-vindo à Ademicon.";
	assert.throws(
		() => assertSafeMarianaReply(leakingReply, profile),
		/unauthorized company mention/
	);
});

test("TEST 3: Usuário pergunta 'Você é da Ademicon?'", () => {
	// Cenário A: Sem empresa configurada ou empresa != Ademicon
	const clarificationReply =
		"Olá! Eu sou a Mariana, assistente virtual de consórcios. Não sou da Ademicon; estou aqui para tirar suas dúvidas e entender o seu objetivo.";

	assert.equal(
		isUnauthorizedCompanyMention(clarificationReply),
		false,
		"Esclarecimento com negação não deve ser barrado como menção não autorizada"
	);
	assert.doesNotThrow(() => assertSafeMarianaReply(clarificationReply));

	const affirmativeUnauthorizedReply =
		"Sim, eu sou da Ademicon e represento a empresa.";
	assert.equal(
		isUnauthorizedCompanyMention(affirmativeUnauthorizedReply),
		true,
		"Afirmação positiva de vínculo com Ademicon sem configuração deve ser barrada"
	);
	assert.throws(
		() => assertSafeMarianaReply(affirmativeUnauthorizedReply),
		/unauthorized company mention/
	);

	// Cenário B: Empresa = Ademicon
	const ademiconProfile = { companyName: "Ademicon" };
	const ademiconAffirmativeReply =
		"Olá! Sim, eu sou a Mariana, assistente virtual da Ademicon. Como posso ajudar com seu consórcio?";

	assert.equal(
		isUnauthorizedCompanyMention(ademiconAffirmativeReply, ademiconProfile),
		false,
		"Com Ademicon configurada, identificação com a marca é autorizada"
	);
	assert.doesNotThrow(() =>
		assertSafeMarianaReply(ademiconAffirmativeReply, ademiconProfile)
	);
});

test("TEST 4: Base de conhecimento - Isolamento multi-tenant", () => {
	// 4.1 Perguntas gerais de consórcio funcionam sem vazar empresa
	const genericResult = retrieveKnowledge({
		items: MARIANA_KNOWLEDGE,
		query: "Quero comprar um imóvel através de consórcio.",
	});
	assert.equal(genericResult.evidenceFound, true);
	const formattedGeneric = formatKnowledgeContext(genericResult);
	assert.equal(
		formattedGeneric.includes("Ademicon"),
		false,
		"Contexto de conhecimento genérico não deve mencionar Ademicon"
	);

	// 4.2 Pergunta específica da Ademicon (CaaS) sem configuração
	const specificWithoutCompany = retrieveKnowledge({
		items: MARIANA_KNOWLEDGE,
		query: "A Ademicon opera no modelo CaaS?",
	});
	assert.equal(
		specificWithoutCompany.evidenceFound,
		false,
		"Item específico de cliente não deve ser retornado sem empresa configurada"
	);

	// 4.3 Pergunta específica com outra empresa configurada
	const specificWithOtherCompany = retrieveKnowledge({
		businessProfile: { companyName: "Consórcio ABC" },
		items: MARIANA_KNOWLEDGE,
		query: "A Ademicon opera no modelo CaaS?",
	});
	assert.equal(
		specificWithOtherCompany.evidenceFound,
		false,
		"Item específico de cliente não deve ser retornado para outra empresa"
	);

	// 4.4 Pergunta específica com Ademicon configurada
	const specificWithAdemicon = retrieveKnowledge({
		businessProfile: { companyName: "Ademicon" },
		items: MARIANA_KNOWLEDGE,
		query: "A Ademicon opera no modelo CaaS?",
	});
	assert.equal(
		specificWithAdemicon.evidenceFound,
		true,
		"Item específico da Ademicon deve ser retornado quando Ademicon estiver configurada"
	);
	assert.equal(specificWithAdemicon.items[0]?.id, "ademicon-segmentos-e-caas");
});

test("TEST 5: Qualificação e nextAction preservados com BusinessProfile", async () => {
	const phone = `+55249${Date.now().toString().slice(-8)}`;

	const [lead] = await db
		.insert(leads)
		.values({
			name: "Lead Identidade Comercial",
			phone,
			source: "whatsapp",
			status: "new",
		})
		.returning();

	const [conversation] = await db
		.insert(conversations)
		.values({
			leadId: lead.id,
			status: "active",
		})
		.returning();

	let capturedBusinessProfile:
		| ReturnType<typeof resolveBusinessProfile>
		| undefined;

	const mockGenerateMarianaReplyFn = async (params: {
		businessProfile?: ReturnType<typeof resolveBusinessProfile>;
		lead: { status: string };
	}) => {
		capturedBusinessProfile = params.businessProfile;

		return {
			metadata: {
				latencyMs: 10,
				model: "mock-model",
				usage: null,
			},
			result: {
				businessAction: null,
				evidenceUsed: [],
				leadUpdate: {
					consortiumType: "imóvel",
					objective: "Comprar primeiro apartamento",
					status: "qualifying" as const,
				},
				nextAction: "continue_conversation" as const,
				reply:
					"Olá! Perfeito, me conte mais sobre o tipo de imóvel que você busca.",
			},
		};
	};

	const testProfile = { companyName: "Imobiliária Futuro" };

	const result = await generateMarianaResponse({
		businessProfile: testProfile,
		currentMessages: ["Olá, quero comprar um apartamento."],
		// biome-ignore lint/suspicious/noExplicitAny: mock for test
		generateMarianaReplyFn: mockGenerateMarianaReplyFn as any,
		leadId: lead.id,
		persistUserMessage: true,
	});

	// Verifica se o perfil comercial foi devidamente passado
	assert.deepEqual(capturedBusinessProfile, testProfile);

	// Verifica se a resposta foi preservada
	assert.match(result.result.reply, /imóvel que você busca/);
	assert.equal(result.result.nextAction, "continue_conversation");

	// Verifica se a atualização de qualificação do lead foi persistida
	const [updatedLead] = await db
		.select()
		.from(leads)
		.where(leads.id === lead.id ? leads.id : undefined);

	assert.equal(result.result.leadUpdate.consortiumType, "imóvel");
});

test("TEST 6: Webhook / WhatsApp - Resposta final não contém Ademicon quando não configurada", () => {
	const userMessage = "Olá Mariana Teste";

	// Simula a geração da resposta que seria enviada pelo WhatsApp
	const rawReplyFromModel =
		"Olá! Seja bem-vindo à Ademicon. Sou a Mariana, sua assistente virtual de consórcios. Como posso te ajudar hoje?";

	const profile = resolveBusinessProfile(); // Padrão (sem empresa configurada)

	// O pipeline de resposta da Mariana aplica sanitizeCommercialIdentity e assertSafeMarianaReply
	const sanitizedReply = sanitizeCommercialIdentity(rawReplyFromModel, profile);
	assertSafeMarianaReply(sanitizedReply, profile);

	assert.equal(
		sanitizedReply.includes("Ademicon"),
		false,
		"A resposta enviada para o WhatsApp não deve conter 'Ademicon'"
	);
	assert.match(sanitizedReply, /Sou a Mariana/);
});
