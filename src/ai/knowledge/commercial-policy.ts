import type { CommercialAccessLevel, KnowledgeRetrievalResult } from "./types";

export interface CommercialAccessResolution {
	level: CommercialAccessLevel;
	reason: string;
}

const normalize = (value: string) =>
	value
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();

const hasAny = (value: string, terms: readonly string[]) =>
	terms.some((term) => value.includes(term));
const SPECIFIC_AMOUNT_PATTERN =
	/\b\d+(?:[.,]\d+)?\s*(?:%|mil|milhao|milhoes|reais|r\$)?\b/;
const PERCENTAGE_PATTERN = /\b\d+\s*%/;

function isSpecificAmountQuestion(message: string): boolean {
	return (
		SPECIFIC_AMOUNT_PATTERN.test(message) &&
		hasAny(message, ["taxa", "parcela", "carta", "lance", "grupo", "simul"])
	);
}

function isLevelThreeQuestion(message: string): string | undefined {
	if (
		hasAny(message, [
			"simulacao",
			"simular",
			"quanto vou pagar",
			"valor da parcela",
			"valor de parcela",
			"parcela mensal",
		]) ||
		isSpecificAmountQuestion(message)
	) {
		return "solicitação de valor, parcela ou simulação específica";
	}

	if (
		hasAny(message, [
			"taxa exata",
			"percentual da taxa",
			"qual a taxa",
			"qual é a taxa",
			"quanto e a taxa",
			"quanto é a taxa",
			"valor da taxa",
		])
	) {
		return "solicitação de taxa exata ou percentual";
	}

	if (
		hasAny(message, [
			"qual lance",
			"quanto dar de lance",
			"lance devo",
			"lance recomendado",
			"percentual de lance",
			"media de lance",
			"média de lance",
		]) ||
		(message.includes("lance") && PERCENTAGE_PATTERN.test(message))
	) {
		return "solicitação de lance, percentual ou recomendação de lance";
	}

	if (
		hasAny(message, [
			"qual grupo",
			"grupo melhor",
			"melhor grupo",
			"grupo especifico",
			"meu grupo",
			"qual carta",
			"carta melhor",
			"melhor carta",
			"carta especifica",
			"minha carta",
		])
	) {
		return "solicitação de grupo ou carta específica/recomendada";
	}

	if (
		hasAny(message, [
			"quanto tempo",
			"quando vou ser contemplado",
			"prazo de contemplacao",
			"prazo para contemplacao",
			"previsao de contemplacao",
		])
	) {
		return "solicitação de prazo ou previsão de contemplação";
	}

	if (
		hasAny(message, [
			"promessa de contemplacao",
			"garantia de contemplacao",
			"contemplacao garantida",
			"contemplacao e garantida",
			"vou ser contemplado",
		])
	) {
		return "solicitação de promessa ou garantia de contemplação";
	}

	if (
		hasAny(message, [
			"da lucro",
			"dá lucro",
			"retorno financeiro",
			"rentabilidade",
			"lucro",
		])
	) {
		return "solicitação de lucro, retorno ou rentabilidade";
	}

	if (
		hasAny(message, [
			"qual estrategia",
			"qual estratégia",
			"estrategia devo",
			"estratégia devo",
			"recomenda",
			"indica para mim",
		])
	) {
		return "solicitação de recomendação ou estratégia personalizada";
	}

	if (
		hasAny(message, [
			"aprovacao especifica",
			"liberacao especifica",
			"disponibilidade",
			"condicao do meu",
		])
	) {
		return "solicitação de condição específica da operação";
	}
}

function isLevelTwoQuestion(message: string): boolean {
	return hasAny(message, [
		"como funciona o lance",
		"como funciona lance",
		"o que e lance",
		"como funciona o sorteio",
		"como funciona sorteio",
		"o que e sorteio",
		"existe taxa de administracao",
		"o que e taxa de administracao",
		"como funciona taxa de administracao",
		"o que e carta contemplada",
		"carta contemplada",
	]);
}

export function resolveCommercialAccess({
	message,
	retrievedKnowledge,
}: {
	message: string;
	retrievedKnowledge: KnowledgeRetrievalResult;
}): CommercialAccessResolution {
	const normalizedMessage = normalize(message);
	const levelThreeReason = isLevelThreeQuestion(normalizedMessage);
	if (levelThreeReason) {
		return { level: 3, reason: levelThreeReason };
	}

	if (isLevelTwoQuestion(normalizedMessage)) {
		return {
			level: 2,
			reason: "pergunta conceitual com detalhamento comercial restrito",
		};
	}

	const restrictedEvidence = retrievedKnowledge.items.find(
		(item) => item.accessLevel === 2
	);
	if (restrictedEvidence) {
		return {
			level: 2,
			reason: `evidência ${restrictedEvidence.id} exige explicação sem detalhamento`,
		};
	}

	return { level: 1, reason: "informação geral autorizada" };
}

export const COMMERCIAL_HANDOFF =
	"Essa é uma questão específica da operação e precisa ser analisada por um consultor. Posso encaminhar você para esse atendimento.";

export const LEVEL_TWO_INSTRUCTION =
	"Responda apenas o conceito geral. Não informe números, percentuais, simulações, condições específicas ou recomendações personalizadas. Encaminhe detalhes operacionais a um consultor.";
