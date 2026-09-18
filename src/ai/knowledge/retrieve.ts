import type {
	KnowledgeCategory,
	KnowledgeItem,
	KnowledgeRetrievalResult,
	RetrievedKnowledgeItem,
} from "./types";

const STOP_WORDS = new Set([
	"a",
	"as",
	"com",
	"da",
	"de",
	"do",
	"e",
	"em",
	"é",
	"eu",
	"o",
	"os",
	"para",
	"por",
	"que",
	"qual",
	"quanto",
	"um",
	"uma",
	"vou",
]);
const TOKEN_SEPARATOR = /\s+/;

const normalize = (value: string) =>
	value
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9%]+/g, " ")
		.trim();

const tokenize = (value: string) =>
	normalize(value)
		.split(TOKEN_SEPARATOR)
		.filter((token) => token.length >= 3 && !STOP_WORDS.has(token));

const toRetrievedItem = (
	item: KnowledgeItem,
	relevance: number
): RetrievedKnowledgeItem => ({
	accessLevel: item.accessLevel ?? 1,
	category: item.category,
	content: item.content,
	id: item.id,
	relevance,
	source: item.source,
	supportsSpecificQuestions: item.supportsSpecificQuestions,
	version: item.version,
});

export function retrieveKnowledge({
	category,
	items,
	query,
}: {
	category?: KnowledgeCategory;
	items: KnowledgeItem[];
	query: string;
}): KnowledgeRetrievalResult {
	const queryTokens = tokenize(query);
	const candidates = items
		.filter((item) => item.clientAllowed)
		.filter((item) => category === undefined || item.category === category)
		.map((item) => {
			const searchableTokens = new Set(
				tokenize(`${item.content} ${item.keywords.join(" ")}`)
			);
			const matchedTokens = queryTokens.filter((token) =>
				searchableTokens.has(token)
			);
			const relevance = matchedTokens.length;

			return { item, relevance };
		})
		.filter(({ relevance }) => relevance > 0)
		.sort(
			(left, right) =>
				right.relevance - left.relevance ||
				left.item.id.localeCompare(right.item.id)
		)
		.map(({ item, relevance }) => toRetrievedItem(item, relevance));
	const specificQuestion = requiresSpecificCommercialEvidence(query);
	const authorizedCandidates = specificQuestion
		? candidates.filter((item) => item.supportsSpecificQuestions === true)
		: candidates;

	return {
		evidenceFound: authorizedCandidates.length > 0,
		items: authorizedCandidates,
	};
}

export function formatKnowledgeContext(
	result: KnowledgeRetrievalResult
): string {
	if (!result.evidenceFound) {
		return "Nenhuma evidência autorizada foi encontrada para a pergunta atual. Não afirme o fato comercial e encaminhe a questão ao consultor quando ela exigir análise específica.";
	}

	return result.items
		.map(
			(item) =>
				`- id: ${item.id}\n  source: ${item.source}\n  category: ${item.category}\n  version: ${item.version}\n  content: ${item.content}`
		)
		.join("\n");
}

export function requiresSpecificCommercialEvidence(query: string): boolean {
	const normalizedQuery = normalize(query);
	return [
		"qual grupo",
		"grupo melhor",
		"melhor grupo",
		"percentual de lance",
		"quanto dar de lance",
		"qual lance",
		"media de lance",
		"medias de lance",
		"quando vou ser contemplado",
		"quanto tempo vou levar",
		"quanto tempo para ser contemplado",
		"prazo de contemplacao",
		"tempo para contemplacao",
		"quanto vou lucrar",
		"da lucro",
		"dar lucro",
		"retorno financeiro",
		"rentabilidade",
	].some((pattern) => normalizedQuery.includes(pattern));
}

export function hasRetrievedEvidence(
	id: string,
	result: KnowledgeRetrievalResult
): boolean {
	return result.items.some((item) => item.id === id);
}
