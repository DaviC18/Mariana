/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import type { LeadQualificationInput } from "./lead-qualification";

// Mesma ordem e mesmos requisitos de isLeadQualified.
export const QUALIFICATION_FIELDS = [
	"objective",
	"consortiumType",
	"currentSituation",
	"painPoint",
	"interestedInConsultant",
] as const;

export type QualificationField = (typeof QUALIFICATION_FIELDS)[number];

export const DEFAULT_FALLBACK_REPLY =
	"Posso te ajudar com outras dúvidas sobre consórcio. O que mais você gostaria de saber?";

const FIELD_DESCRIPTIONS: Record<QualificationField, string> = {
	consortiumType: "tipo de consórcio (imóvel, veículo, serviços etc.)",
	currentSituation:
		"situação atual do cliente em relação ao objetivo (ex.: já possui o bem, mora de aluguel, usa transporte por aplicativo)",
	interestedInConsultant:
		"interesse explícito em conversar com um consultor (precisa ser confirmado pelo cliente)",
	objective: "objetivo do cliente (o que pretende conquistar com o consórcio)",
	painPoint: "motivação ou ponto de dor (por que quer isso agora)",
};

const FIELD_QUESTIONS: Record<QualificationField, string> = {
	consortiumType:
		"Você está pensando em consórcio de imóvel, de veículo ou de outro tipo de bem?",
	currentSituation:
		"Para eu entender melhor o seu momento, como está a sua situação hoje em relação a esse objetivo?",
	interestedInConsultant:
		"Você quer que eu procure um horário para conversar com um consultor?",
	objective:
		"Para eu te orientar melhor, qual é o seu principal objetivo com o consórcio?",
	painPoint: "E o que te motivou a buscar essa conquista agora?",
};

// Reformulações usadas quando a pergunta principal acabou de ser enviada.
const FIELD_ALTERNATE_QUESTIONS: Record<QualificationField, string> = {
	consortiumType:
		"Só para eu confirmar: o consórcio que você procura é para imóvel, veículo ou outro bem?",
	currentSituation:
		"Me conta um pouco mais: hoje, como você está em relação a esse objetivo?",
	interestedInConsultant:
		"Posso procurar uma data e um horário para você falar com um consultor?",
	objective: "Me conta: o que você pretende conquistar com o consórcio?",
	painPoint: "O que fez você querer resolver isso neste momento?",
};

const DEFAULT_ALTERNATE_FALLBACK_REPLY =
	"Ficou alguma dúvida sobre consórcio que eu possa esclarecer?";

function hasText(value: string | null | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function isFieldMissing(
	field: QualificationField,
	lead: LeadQualificationInput
): boolean {
	switch (field) {
		case "painPoint":
			return !(hasText(lead.painPoint) || hasText(lead.motivation));
		case "interestedInConsultant":
			return !(
				lead.interestedInConsultant === true ||
				lead.interestedInConsultant === "true"
			);
		default:
			return !hasText(lead[field]);
	}
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

// Nunca repete a última mensagem da assistente: usa uma reformulação do mesmo
// campo, sem pular a ordem de qualificação, evitando loop da mesma pergunta.
export function buildQualificationFallbackReply(
	fields: readonly QualificationField[],
	previousAssistantMessage?: string | null
): string {
	const [firstMissingField] = fields;
	const [primary, alternate] = firstMissingField
		? [
				FIELD_QUESTIONS[firstMissingField],
				FIELD_ALTERNATE_QUESTIONS[firstMissingField],
			]
		: [DEFAULT_FALLBACK_REPLY, DEFAULT_ALTERNATE_FALLBACK_REPLY];

	return primary === previousAssistantMessage?.trim() ? alternate : primary;
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

// Sobrepõe ao lead somente os valores que o modelo realmente preencheu.
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
