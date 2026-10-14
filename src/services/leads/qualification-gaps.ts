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
		"Você gostaria de conversar com um consultor para conhecer as opções com mais detalhes?",
	objective:
		"Para eu te orientar melhor, qual é o seu principal objetivo com o consórcio?",
	painPoint: "E o que te motivou a buscar essa conquista agora?",
};

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

export function buildQualificationFallbackReply(
	fields: readonly QualificationField[]
): string {
	const [firstMissingField] = fields;

	return firstMissingField
		? FIELD_QUESTIONS[firstMissingField]
		: DEFAULT_FALLBACK_REPLY;
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
