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

export function isLeadQualified({
	birthDate,
	consortiumType,
	currentSituation,
	interestedInConsultant,
	motivation,
	objective,
	painPoint,
}: LeadQualificationInput): boolean {
	if (
		birthDate !== null &&
		birthDate !== undefined &&
		!isAtLeast18(birthDate)
	) {
		return false;
	}
	const normalizedObjective = normalizeText(objective);
	const normalizedConsortiumType = normalizeText(consortiumType);
	const normalizedCurrentSituation = normalizeText(currentSituation);
	const hasPainPoint =
		normalizeText(painPoint) !== undefined ||
		normalizeText(motivation) !== undefined;
	const normalizedInterestedInConsultant =
		interestedInConsultant === true || interestedInConsultant === "true";

	return (
		normalizedObjective !== undefined &&
		normalizedConsortiumType !== undefined &&
		hasPainPoint &&
		normalizedCurrentSituation !== undefined &&
		normalizedInterestedInConsultant
	);
}
