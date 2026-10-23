/** biome-ignore-all lint/style/useFilenamingConvention: <> */

export interface LeadQualificationInput {
	birthDate?: Date | string | null;
	consortiumType?: string | null;
	currentSituation?: string | null;
	interestedInConsultant?: boolean | string | null;
	motivation?: string | null;
	objective?: string | null;
	painPoint?: string | null;
}

export function isAtLeast18(
	birthDate: Date | string,
	referenceDate = new Date()
): boolean {
	const parsedBirthDate =
		birthDate instanceof Date ? birthDate : new Date(birthDate);
	if (
		Number.isNaN(parsedBirthDate.getTime()) ||
		parsedBirthDate > referenceDate
	) {
		return false;
	}

	let age = referenceDate.getUTCFullYear() - parsedBirthDate.getUTCFullYear();
	const birthdayHasNotOccurred =
		referenceDate.getUTCMonth() < parsedBirthDate.getUTCMonth() ||
		(referenceDate.getUTCMonth() === parsedBirthDate.getUTCMonth() &&
			referenceDate.getUTCDate() < parsedBirthDate.getUTCDate());
	if (birthdayHasNotOccurred) {
		age -= 1;
	}

	return age >= 18;
}

function normalizeText(value: string | null | undefined): string | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

// Mínimo para oferecer horários: objetivo conhecido (o tipo de consórcio é
// inferido dele) + cliente quer falar com um consultor, respeitando 18+.
// Tipo, situação atual e motivação são opcionais e nunca bloqueiam.
export function isLeadQualified({
	birthDate,
	interestedInConsultant,
	objective,
}: LeadQualificationInput): boolean {
	if (
		birthDate !== null &&
		birthDate !== undefined &&
		!isAtLeast18(birthDate)
	) {
		return false;
	}

	return (
		normalizeText(objective) !== undefined &&
		(interestedInConsultant === true || interestedInConsultant === "true")
	);
}
