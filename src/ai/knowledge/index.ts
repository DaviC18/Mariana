import { ADEMICON_KNOWLEDGE } from "./ademicon";
import { CONSORTIUM_KNOWLEDGE } from "./consorcio";
import { PRODUCTS_KNOWLEDGE } from "./products";
import type { KnowledgeItem } from "./types";

export const MARIANA_KNOWLEDGE: KnowledgeItem[] = [
	...ADEMICON_KNOWLEDGE,
	...PRODUCTS_KNOWLEDGE,
	...CONSORTIUM_KNOWLEDGE,
	{
		category: "qualification",
		clientAllowed: true,
		content: "A idade mínima para contratação é 18 anos.",
		id: "qualificacao-idade-minima",
		keywords: ["idade", "minima", "contratacao", "anos", "elegibilidade"],
		source: "Ademicon - política de qualificação aprovada",
		version: "2026-09-16",
	},
	{
		category: "internal",
		clientAllowed: false,
		content:
			"A Mariana não deve recomendar grupo, carta de crédito, percentual de lance ou estratégia de contemplação personalizada.",
		id: "politica-interna-sem-recomendacao-personalizada",
		keywords: [
			"recomendar",
			"grupo",
			"carta",
			"percentual",
			"estrategia",
			"personalizada",
		],
		source: "Ademicon - política interna de atendimento",
		version: "2026-09-16",
	},
];
