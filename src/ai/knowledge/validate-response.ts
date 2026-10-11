import type { MarianaResponse } from "../schemas/mariana-response-schema";
import {
	COMMERCIAL_HANDOFF,
	type CommercialAccessResolution,
} from "./commercial-policy";
import {
	hasRetrievedEvidence,
	requiresSpecificCommercialEvidence,
} from "./retrieve";
import type { KnowledgeRetrievalResult } from "./types";

const UNSUPPORTED_COMMERCIAL_CLAIMS = [
	/medias? de lances?/i,
	/antecipar(?: a)? contemplacao/i,
	/percentual de lance de \d+/i,
	/\bgrupo\s+(?:melhor|ideal|certo)\b/i,
	/\b\d+\s*%\s*de\s*(?:lucro|retorno|rentabilidade)/i,
	/\b(?:lucro|retorno|rentabilidade)\b.{0,30}\bgarant/i,
	/\bem ate \d+ meses\b/i,
];

const CONSULTANT_FALLBACK = COMMERCIAL_HANDOFF;

const LEVEL_TWO_RESTRICTIONS = [
	/\b\d+(?:[.,]\d+)?\s*(?:%|mil|milhao|milhoes|reais|r\$)?\b/i,
	/\b(?:simulacao|simular|lance de|percentual|media de lance)\b/i,
	/\b(?:recomendo|indico|sugiro|melhor grupo|melhor carta|estrategia para voce)\b/i,
];

export function validateMarianaEvidence({
	query,
	response,
	retrieval,
	commercialAccess,
}: {
	query: string;
	response: MarianaResponse;
	retrieval: KnowledgeRetrievalResult;
	commercialAccess?: CommercialAccessResolution;
}): MarianaResponse {
	const evidenceUsed = response.evidenceUsed ?? [];
	if (evidenceUsed.some((id) => !hasRetrievedEvidence(id, retrieval))) {
		throw new Error(
			"Mariana response referenced unavailable knowledge evidence"
		);
	}

	const unsupportedClaim = UNSUPPORTED_COMMERCIAL_CLAIMS.some((pattern) =>
		pattern.test(
			response.reply.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
		)
	);
	const needsSpecificEvidence = requiresSpecificCommercialEvidence(query);
	const normalizedReply = response.reply
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");
	const levelTwoViolation =
		commercialAccess?.level === 2 &&
		LEVEL_TWO_RESTRICTIONS.some((pattern) => pattern.test(normalizedReply));

	if (
		levelTwoViolation ||
		(unsupportedClaim && !retrieval.evidenceFound) ||
		(needsSpecificEvidence && !retrieval.evidenceFound)
	) {
		return {
			...response,
			businessAction: "request_consultant",
			evidenceUsed: [],
			needsConfirmation: false,
			nextAction: "request_consultant",
			reply: CONSULTANT_FALLBACK,
		};
	}

	return response;
}

export { CONSULTANT_FALLBACK };
