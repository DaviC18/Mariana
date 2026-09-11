/** biome-ignore-all lint/style/useFilenamingConvention: <> */

export interface LeadQualificationInput {
	consortiumType?: string | null;
	currentSituation?: string | null;
	interestedInConsultant?: boolean | string | null;
	motivation?: string | null;
	objective?: string | null;
	painPoint?: string | null;
}

function normalizeText(value: string | null | undefined): string | undefined {
	if (value === null || value === undefined) {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function isLeadQualified({
	consortiumType,
	currentSituation,
	interestedInConsultant,
	motivation,
	objective,
	painPoint,
}: LeadQualificationInput): boolean {
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
