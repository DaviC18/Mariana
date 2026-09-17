import type { MarianaResponse } from "../schemas/mariana-response-schema";
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

const CONSULTANT_FALLBACK =
	"Essa é uma questão específica da operação e precisa ser analisada por um consultor. Posso encaminhar você para esse atendimento.";

export function validateMarianaEvidence({
	query,
	response,
	retrieval,
}: {
	query: string;
	response: MarianaResponse;
	retrieval: KnowledgeRetrievalResult;
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

	if (
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
