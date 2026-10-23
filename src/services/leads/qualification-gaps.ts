/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import type { LeadQualificationInput } from "./lead-qualification";

// Mesmos requisitos de isLeadQualified: objetivo + interesse no consultor.
export const QUALIFICATION_FIELDS = [
	"objective",
	"interestedInConsultant",
] as const;

// Perguntados no máximo uma vez cada; nunca bloqueiam o agendamento.
export const OPTIONAL_QUALIFICATION_FIELDS = [
	"currentSituation",
	"painPoint",
] as const;

export type QualificationField = (typeof QUALIFICATION_FIELDS)[number];

export const DEFAULT_FALLBACK_REPLY =
	"Posso te ajudar com outras dúvidas sobre consórcio. O que mais você gostaria de saber?";

// Perguntas de etapa. Só o backend as envia, e cada uma é enviada no máximo
// uma vez por conversa (conversation-stage.ts).
export const NAME_QUESTION = "Como posso te chamar?";
export const REASON_QUESTION =
	"O que você está buscando hoje, por exemplo, um carro, um imóvel ou outro bem?";
export const CONSULTANT_REASON_QUESTION =
	"Para eu direcionar ao consultor certo, o que você quer conquistar com o consórcio?";
export const CURRENT_SITUATION_QUESTION =
	"Hoje, como está a sua situação em relação a esse objetivo?";
export const PAIN_POINT_QUESTION = "E o que te motivou a buscar isso agora?";

// Frases sem pergunta para quando não há nada a perguntar. Alternam para
// nunca repetir a mensagem anterior.
export const NEUTRAL_FALLBACK_REPLIES = [
	"Fico à disposição para qualquer dúvida sobre consórcio.",
	"Se quiser saber mais sobre consórcio, é só me perguntar.",
] as const;

// Textos usados por versões anteriores do backend. Continuam contando como
// perguntas já feitas em conversas antigas.
export const LEGACY_QUESTION_TEXTS = {
	consultantOffer: [
		"Posso procurar uma data e um horário para você falar com um consultor?",
		"Posso encaminhar você para esse atendimento.",
	],
	currentSituation: [
		"Para eu entender melhor o seu momento, como está a sua situação hoje em relação a esse objetivo?",
		"Me conta um pouco mais: hoje, como você está em relação a esse objetivo?",
	],
	painPoint: [
		"E o que te motivou a buscar essa conquista agora?",
		"O que fez você querer resolver isso neste momento?",
	],
	reason: [
		"Para eu te orientar melhor, qual é o seu principal objetivo com o consórcio?",
		"Me conta: o que você pretende conquistar com o consórcio?",
		"Você está pensando em consórcio de imóvel, de veículo ou de outro tipo de bem?",
		"Só para eu confirmar: o consórcio que você procura é para imóvel, veículo ou outro bem?",
	],
} as const;

const FIELD_DESCRIPTIONS: Record<QualificationField, string> = {
	interestedInConsultant:
		"interesse explícito em conversar com um consultor (confirmado pelo cliente)",
	objective: "objetivo do cliente (o que pretende conquistar com o consórcio)",
};

function hasText(value: string | null | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function isFieldMissing(
	field: QualificationField,
	lead: LeadQualificationInput
): boolean {
	if (field === "interestedInConsultant") {
		return !(
			lead.interestedInConsultant === true ||
			lead.interestedInConsultant === "true"
		);
	}

	return !hasText(lead[field]);
}

export function getMissingQualificationFields(
	lead: LeadQualificationInput
): QualificationField[] {
	return QUALIFICATION_FIELDS.filter((field) => isFieldMissing(field, lead));
}

export function describeQualificationFields(
	fields: readonly QualificationField[]
): string[] {
	return fields.map((field) => FIELD_DESCRIPTIONS[field]);
}

const MERGEABLE_KEYS = [
	"birthDate",
	"consortiumType",
	"currentSituation",
	"interestedInConsultant",
	"motivation",
	"objective",
	"painPoint",
] as const satisfies readonly (keyof LeadQualificationInput)[];

// Sobrepõe ao lead somente os valores que realmente foram preenchidos.
export function mergeQualificationInput(
	lead: LeadQualificationInput,
	leadUpdate: Record<string, unknown>
): LeadQualificationInput {
	const merged: Record<string, unknown> = { ...lead };

	for (const key of MERGEABLE_KEYS) {
		const value = leadUpdate[key];
		if (value !== null && value !== undefined) {
			merged[key] = value;
		}
	}

	return merged as LeadQualificationInput;
}
