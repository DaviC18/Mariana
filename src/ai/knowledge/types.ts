export const KNOWLEDGE_CATEGORIES = [
	"general",
	"commercial",
	"qualification",
	"contractual",
	"internal",
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];
export type CommercialAccessLevel = 1 | 2 | 3;

export interface KnowledgeItem {
	accessLevel?: CommercialAccessLevel;
	category: KnowledgeCategory;
	clientAllowed: boolean;
	content: string;
	id: string;
	keywords: string[];
	source: string;
	supportsSpecificQuestions?: boolean;
	version: string;
}

export interface RetrievedKnowledgeItem {
	accessLevel: CommercialAccessLevel;
	category: KnowledgeCategory;
	content: string;
	id: string;
	relevance: number;
	source: string;
	supportsSpecificQuestions?: boolean;
	version: string;
}

export interface KnowledgeRetrievalResult {
	evidenceFound: boolean;
	items: RetrievedKnowledgeItem[];
}
